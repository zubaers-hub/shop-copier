// Mode 1: photo -> perspective fix -> scale -> trace -> mirror/cleanup -> DXF for Mozaik "DXF In".
import {
  parseInches, formatInches, orderCorners, quadAspect, buildShape, shapeBBox, segPoints, writeDXF, checkDXF,
  autoCenter, dist, toCadSpace, arcGeom,
} from './core.js';
import { loadPhoto, canvasToBlob, straighten, detectOutline, resampleOutline } from './vision.js';
import { Stage } from './stage.js';
import { saveJob } from './store.js';
import { el, toast, downloadBlob, shareFile, safeFileName, ACCURACY_NOTE } from './ui.js';

const STEPS = [
  ['photo', 'Photo'], ['corners', 'Corners'], ['size', 'Size'], ['trace', 'Trace'], ['clean', 'Clean'], ['export', 'Export'],
];

export async function openShapeEditor(view, job, settings, { onTitle }) {
  const ed = new ShapeEditor(view, job, settings, onTitle);
  await ed.init();
  return ed;
}

class ShapeEditor {
  constructor(view, job, settings, onTitle) {
    this.view = view; this.job = job; this.settings = settings; this.onTitle = onTitle;
    job.contours ||= { outer: [], holes: [] };
    job.mirror ||= { on: false, cx: null, keep: 'left' };
    job.smooth ??= 3;
    job.snap ??= true;
    job.corners ||= [];
    this.tool = 'move';
    this.active = -1; // -1 = outline, 0.. = cutout index
    this.drawing = false;
    this.undo = [];
    this.shape = null;
    this.seed = null;
  }

  async init() {
    window.__editor = this; // handy for automated tests
    if (this.job.photo) this.photo = await loadPhoto(this.job.photo);
    if (this.photo && this.job.corners.length === 4 && this.job.rectIn) this.restraighten();
    this.go(this.job.step && this.canGo(this.job.step) ? this.job.step : this.photo ? (this.straight ? 'trace' : 'corners') : 'photo');
  }

  destroy() { if (this.stage) this.stage.destroy(); }

  canGo(step) {
    if (step === 'photo') return true;
    if (step === 'corners') return !!this.photo;
    if (step === 'size') return this.photo && this.job.corners.length === 4;
    if (step === 'trace' || step === 'clean') return !!this.straight;
    if (step === 'export') return !!this.straight && this.job.contours.outer.length >= 3;
    return false;
  }

  save() {
    clearTimeout(this.saveT);
    this.saveT = setTimeout(() => saveJob(this.job).catch((e) => toast('Could not save: ' + e.message)), 400);
  }

  go(step) {
    this.refreshTools = null;
    this.step = step;
    this.job.step = step;
    this.save();
    if (this.stage) { this.stage.destroy(); this.stage = null; }
    this.view.innerHTML = '';
    const bar = el('nav', { class: 'steps' });
    const order = STEPS.map((s) => s[0]);
    STEPS.forEach(([id, label]) => {
      const b = el('button', { class: (id === step ? 'current ' : '') + (order.indexOf(id) < order.indexOf(step) ? 'done' : '') }, label);
      b.disabled = !this.canGo(id);
      b.onclick = () => this.go(id);
      bar.appendChild(b);
    });
    this.view.appendChild(bar);
    ({ photo: () => this.stepPhoto(), corners: () => this.stepCorners(), size: () => this.stepSize(), trace: () => this.stepTrace(),
      clean: () => this.stepClean(), export: () => this.stepExport() })[step]();
    bar.querySelector('.current')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }

  // ---------------------------------------------------------------- step 1: photo
  stepPhoto() {
    const page = el('div', { class: 'page' });
    page.append(
      el('h2', {}, 'Take or choose a photo'),
      el('p', {}, 'Stand square to the part if you can. Get a rectangle in the shot that is truly rectangular: the door, the panel, or a sheet of paper held flat against the part.'),
      el('div', { class: 'note' }, ACCURACY_NOTE),
    );
    const cam = el('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
    const pick = el('input', { type: 'file', accept: 'image/*', hidden: true });
    const take = el('button', { class: 'primary' }, '📷 Take photo');
    const up = el('button', {}, '🖼 Choose photo');
    take.onclick = () => cam.click();
    up.onclick = () => pick.click();
    const onFile = async (input) => {
      const f = input.files && input.files[0];
      if (!f) return;
      toast('Loading photo…');
      this.photo = await loadPhoto(f);
      this.job.photo = await canvasToBlob(this.photo);
      this.job.thumb = thumbOf(this.photo);
      this.job.corners = [];
      this.straight = null;
      this.go('corners');
    };
    cam.onchange = () => onFile(cam);
    pick.onchange = () => onFile(pick);
    page.append(el('div', { class: 'stack' }, take, up), cam, pick);
    if (this.photo) {
      const keep = el('button', { class: 'go' }, 'Keep current photo →');
      keep.onclick = () => this.go('corners');
      page.append(el('h3', {}, 'Current photo'), el('img', { class: 'preview-img', src: this.photo.toDataURL('image/jpeg', 0.6) }), keep);
    }
    this.view.appendChild(page);
  }

  // ---------------------------------------------------------------- step 2: corners
  stepCorners() {
    const wrap = el('div', { class: 'stage-wrap' });
    const hint = el('div', { class: 'hint-badge' });
    wrap.appendChild(hint);
    const editor = el('div', { class: 'editor' }, wrap);
    const panel = el('div', { class: 'panel' });
    const reset = el('button', { class: 'danger' }, 'Clear corners');
    const next = el('button', { class: 'go' }, 'Next: size →');
    reset.onclick = () => { this.job.corners = []; this.straight = null; refresh(); };
    next.onclick = () => this.go('size');
    panel.append(el('div', { class: 'row' }, reset, next));
    editor.appendChild(panel);
    this.view.appendChild(editor);
    let dragging = -1;
    const refresh = () => {
      const n = this.job.corners.length;
      hint.textContent = n < 4
        ? `Tap corner ${n + 1} of 4 of something truly rectangular. Pinch to zoom for accuracy.`
        : 'Drag a corner to fine-tune it (the magnifier helps). Then tap Next.';
      next.disabled = n !== 4;
      this.stage.render();
      this.save();
    };
    this.stage = new Stage(wrap, {
      onPress: (p, st) => {
        const i = this.nearest(this.job.corners.map((c) => st.toScr(c)), st.toScr(p), 34);
        if (i >= 0) { dragging = i; return true; }
        return false;
      },
      onDrag: (p) => { if (dragging >= 0) this.job.corners[dragging] = p; },
      onRelease: () => {
        if (dragging >= 0 && this.job.corners.length === 4) this.job.corners = orderCorners(this.job.corners);
        dragging = -1; this.straight = null; refresh();
      },
      onTap: (p, st, claimed) => {
        if (claimed || this.job.corners.length >= 4) return;
        this.job.corners.push(p);
        if (this.job.corners.length === 4) this.job.corners = orderCorners(this.job.corners);
        this.straight = null;
        refresh();
      },
      draw: (ctx, st) => {
        const pts = this.job.corners.map((c) => st.toScr(c));
        ctx.lineWidth = 2.5; ctx.strokeStyle = '#ffd60a';
        if (pts.length > 1) {
          ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
          if (pts.length === 4) ctx.closePath();
          ctx.stroke();
        }
        pts.forEach((p, i) => {
          ctx.fillStyle = 'rgba(232,93,4,.35)'; ctx.beginPath(); ctx.arc(p[0], p[1], 18, 0, 7); ctx.fill();
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
          ctx.fillStyle = '#fff'; ctx.font = 'bold 14px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(String(i + 1), p[0], p[1] - 28);
          ctx.beginPath(); ctx.moveTo(p[0] - 6, p[1]); ctx.lineTo(p[0] + 6, p[1]); ctx.moveTo(p[0], p[1] - 6); ctx.lineTo(p[0], p[1] + 6); ctx.stroke();
        });
      },
    });
    this.stage.setImage(this.photo);
    refresh();
  }

  // ---------------------------------------------------------------- step 3: size
  stepSize() {
    const page = el('div', { class: 'page' });
    const w = el('input', { inputmode: 'text', placeholder: 'e.g. 14 3/4', value: this.job.realW || '' });
    const h = el('input', { inputmode: 'text', placeholder: 'e.g. 22 1/2', value: this.job.realH || '' });
    const msg = el('div');
    const go = el('button', { class: 'go' }, 'Straighten photo →');
    page.append(
      el('h2', {}, 'How big is that rectangle?'),
      el('p', {}, 'Enter the real size of the rectangle you tapped, in inches. Fractions are fine (14 3/4). Width is corner 1 to 2, height is corner 2 to 3.'),
      el('label', {}, 'Width (inches)'), w,
      el('label', {}, 'Height (inches)'), h,
      el('div', { class: 'note' }, 'Best: enter both. With only one, the other is estimated from the photo and the shape may be stretched a little.'),
      msg, go,
    );
    const check = () => {
      const W = parseInches(w.value), H = parseInches(h.value);
      const okW = W > 0, okH = H > 0;
      msg.className = '';
      msg.textContent = '';
      if (w.value && !okW) { msg.className = 'bad-box'; msg.textContent = 'Can’t read the width. Try 14 3/4 or 14.75'; }
      else if (h.value && !okH) { msg.className = 'bad-box'; msg.textContent = 'Can’t read the height. Try 22 1/2 or 22.5'; }
      go.disabled = !(okW || okH);
      return { W, H, okW, okH };
    };
    w.oninput = h.oninput = check;
    check();
    go.onclick = () => {
      const { W, H, okW, okH } = check();
      const asp = quadAspect(this.job.corners);
      this.job.realW = w.value; this.job.realH = h.value;
      this.job.aspectGuess = !(okW && okH);
      this.job.rectIn = { W: okW ? W : H * asp, H: okH ? H : W / asp };
      const had = this.job.contours.outer.length > 0;
      try { this.restraighten(); } catch (e) { msg.className = 'bad-box'; msg.textContent = e.message; return; }
      if (had) toast('Photo re-straightened. Your traced points were kept.');
      this.go('trace');
    };
    this.view.appendChild(page);
    setTimeout(() => w.focus(), 50);
  }

  restraighten() {
    const { W, H } = this.job.rectIn;
    this.straight = straighten(this.photo, this.job.corners, W, H);
  }

  // inches <-> straightened-canvas px
  px(p) { const s = this.straight; return [(p.x - s.ox) * s.ppi, (p.y - s.oy) * s.ppi]; }
  inch(q) { const s = this.straight; return { x: q[0] / s.ppi + s.ox, y: q[1] / s.ppi + s.oy }; }

  contour(i = this.active) { return i < 0 ? this.job.contours.outer : this.job.contours.holes[i]; }
  setContour(pts, i = this.active) { if (i < 0) this.job.contours.outer = pts; else this.job.contours.holes[i] = pts; }

  pushUndo() {
    this.undo.push(JSON.stringify({ c: this.job.contours, m: this.job.mirror }));
    if (this.undo.length > 40) this.undo.shift();
  }
  popUndo() {
    const s = this.undo.pop();
    if (!s) { toast('Nothing to undo'); return; }
    const o = JSON.parse(s);
    this.job.contours = o.c; this.job.mirror = o.m;
    if (this.active >= this.job.contours.holes.length) this.active = -1;
    this.changed();
  }

  rebuild() {
    const raw = this.job.contours;
    if (raw.outer.length < 3) { this.shape = null; return; }
    const m = this.job.mirror;
    if (m.on && m.cx == null) m.cx = autoCenter(raw.outer);
    try {
      this.shape = buildShape(raw, { mirror: m, smooth: this.job.smooth, snap: this.job.snap });
    } catch (e) {
      console.error(e);
      this.shape = null;
    }
  }

  changed(now = false) {
    clearTimeout(this.buildT);
    const run = () => { this.rebuild(); this.updateBadges && this.updateBadges(); this.stage && this.stage.render(); };
    if (now) run(); else this.buildT = setTimeout(run, 120);
    this.stage && this.stage.render();
    this.save();
  }

  // ---------------------------------------------------------------- steps 4 & 5: trace and clean (one canvas)
  buildCanvasEditor(panelBuilder, hintText) {
    const wrap = el('div', { class: 'stage-wrap' });
    const dims = el('div', { class: 'dims-badge' });
    const hint = el('div', { class: 'hint-badge' }, hintText);
    wrap.append(dims, hint);
    const editor = el('div', { class: 'editor' }, wrap);
    const panel = el('div', { class: 'panel' });
    editor.appendChild(panel);
    this.view.appendChild(editor);
    this.hintEl = hint;
    this.updateBadges = () => {
      if (this.shape && this.shape.outer.length) {
        const bb = shapeBBox(this.shape);
        const d = this.settings.denom;
        dims.textContent = `${formatInches(bb.w, d)} W × ${formatInches(bb.h, d)} H`;
        dims.style.display = '';
      } else dims.style.display = 'none';
    };
    let drag = null;
    this.stage = new Stage(wrap, {
      onPress: (p, st) => {
        const sp = st.toScr(p);
        if (this.step === 'clean' && this.job.mirror.on && this.job.mirror.cx != null) {
          const cxs = st.toScr(this.px({ x: this.job.mirror.cx, y: 0 }))[0];
          if (Math.abs(sp[0] - cxs) < 26) { this.pushUndo(); drag = { kind: 'center' }; return true; }
        }
        if (this.tool === 'move') {
          const c = this.contour();
          const i = c ? this.nearest(c.map((q) => st.toScr(this.px(q))), sp, 26) : -1;
          if (i >= 0) { this.pushUndo(); drag = { kind: 'point', i }; return true; }
        }
        return false;
      },
      onDrag: (p) => {
        if (!drag) return;
        const q = this.inch(p);
        if (drag.kind === 'center') this.job.mirror.cx = q.x;
        else { const c = this.contour(); c[drag.i] = { ...c[drag.i], x: q.x, y: q.y }; }
        this.stage.render();
      },
      onRelease: () => { if (drag) { drag = null; this.changed(); } },
      onTap: (p, st, claimed) => { if (!claimed) this.tap(p, st); },
      draw: (ctx, st, inLoupe) => this.drawOverlay(ctx, st, inLoupe),
    });
    this.stage.setImage(this.straight.canvas);
    // zoom to the reference rectangle plus the traced part
    const pts = [...this.job.contours.outer.map((q) => this.px(q)), this.px({ x: 0, y: 0 }), this.px({ x: this.job.rectIn.W, y: this.job.rectIn.H })];
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    const pad = 30;
    this.stage.fit({ x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + 2 * pad, h: Math.max(...ys) - Math.min(...ys) + 2 * pad });
    panelBuilder(panel);
    this.changed(true);
  }

  tap(p, st) {
    const sp = st.toScr(p);
    const c = this.contour() || [];
    const q = this.inch(p);
    if (this.drawing) {
      if (c.length >= 3 && Math.hypot(...sub2(st.toScr(this.px(c[0])), sp)) < 28) { this.finishDrawing(); return; }
      this.pushUndo();
      c.push({ x: q.x, y: q.y });
      this.setContour(c);
      this.changed();
      return;
    }
    if (this.tool === 'add') {
      if (c.length < 2) return;
      // insert on the nearest edge
      let best = -1, bd = Infinity;
      for (let i = 0; i < c.length; i++) {
        const a = st.toScr(this.px(c[i])), b = st.toScr(this.px(c[(i + 1) % c.length]));
        const d = segDist(sp, a, b);
        if (d < bd) { bd = d; best = i; }
      }
      if (bd > 40) { toast('Tap closer to the outline to add a point there'); return; }
      this.pushUndo();
      c.splice(best + 1, 0, { x: q.x, y: q.y });
      this.changed();
    } else if (this.tool === 'delete' || this.tool === 'corner') {
      const i = this.nearest(c.map((r) => st.toScr(this.px(r))), sp, 30);
      if (i < 0) return;
      this.pushUndo();
      if (this.tool === 'delete') c.splice(i, 1);
      else {
        // auto -> corner -> smooth -> auto
        const cur = c[i].corner;
        c[i] = { ...c[i], corner: cur === undefined ? true : cur === true ? false : undefined };
        if (c[i].corner === undefined) delete c[i].corner;
        toast(c[i].corner === true ? 'Sharp corner' : c[i].corner === false ? 'Smooth point (never a corner)' : 'Automatic');
      }
      this.changed();
    } else if (this.tool === 'seed') {
      this.seed = p;
      toast('Got it. Now tap Auto-detect.');
      this.tool = 'move';
      this.refreshTools && this.refreshTools();
      this.stage.render();
    }
  }

  finishDrawing() {
    this.drawing = false;
    const c = this.contour();
    if (c.length < 3) { toast('Need at least 3 points'); return; }
    toast('Shape closed');
    this.refreshTools && this.refreshTools();
    this.changed();
  }

  drawOverlay(ctx, st, inLoupe) {
    const S = (q) => st.toScr(this.px(q));
    // reference rectangle
    if (this.job.rectIn) {
      const r = [[0, 0], [this.job.rectIn.W, 0], [this.job.rectIn.W, this.job.rectIn.H], [0, this.job.rectIn.H]].map(([x, y]) => S({ x, y }));
      ctx.setLineDash([6, 6]); ctx.strokeStyle = 'rgba(255,214,10,.8)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); r.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p))); ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
    }
    const m = this.job.mirror;
    if (this.step === 'clean' && m.on && m.cx != null) {
      const x = S({ x: m.cx, y: 0 })[0];
      // shade the side that gets replaced by the mirror image
      ctx.fillStyle = 'rgba(0,0,0,.35)';
      if (m.keep === 'left') ctx.fillRect(x, 0, st.cssW - x, st.cssH); else ctx.fillRect(0, 0, x, st.cssH);
      ctx.strokeStyle = '#ff2fd0'; ctx.lineWidth = 2.5; ctx.setLineDash([10, 6]);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, st.cssH); ctx.stroke(); ctx.setLineDash([]);
      if (!inLoupe) {
        ctx.fillStyle = '#ff2fd0'; ctx.beginPath(); ctx.roundRect(x - 22, 46, 44, 44, 10); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = 'bold 20px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('⇔', x, 68);
      }
    }
    // raw traced contours
    const all = [this.job.contours.outer, ...this.job.contours.holes];
    all.forEach((c, k) => {
      if (!c || !c.length) return;
      const isActive = k - 1 === this.active;
      const pts = c.map(S);
      ctx.strokeStyle = isActive ? 'rgba(66,165,245,.95)' : 'rgba(66,165,245,.5)';
      ctx.lineWidth = isActive ? 2 : 1.25;
      ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
      if (!(this.drawing && isActive)) ctx.closePath();
      ctx.stroke();
      if (isActive && this.step === 'trace') {
        const dense = pts.length > 150 && st.view.s < 4 && !inLoupe;
        pts.forEach((p, i) => {
          const q = c[i];
          if (dense && q.corner === undefined && i % 4) return;
          if (q.corner === true) { ctx.fillStyle = '#ffd60a'; ctx.fillRect(p[0] - 6, p[1] - 6, 12, 12); ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.strokeRect(p[0] - 6, p[1] - 6, 12, 12); }
          else {
            ctx.fillStyle = q.corner === false ? '#00e5ff' : '#fff'; ctx.strokeStyle = '#1565c0'; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.arc(p[0], p[1], dense ? 3 : 5.5, 0, 7); ctx.fill(); ctx.stroke();
          }
        });
        if (this.drawing && pts.length) { ctx.strokeStyle = '#ffd60a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(pts[0][0], pts[0][1], 14, 0, 7); ctx.stroke(); }
      }
    });
    // cleaned shape
    if (this.shape) {
      ctx.strokeStyle = '#ff6b00'; ctx.lineWidth = this.step === 'clean' ? 3.5 : 2.5; ctx.lineJoin = 'round';
      for (const loop of [this.shape.outer, ...this.shape.holes]) {
        ctx.beginPath();
        loop.forEach((s, i) => segPoints(s, 0.05).forEach((q, j) => { const p = S({ x: q[0], y: q[1] }); if (i === 0 && j === 0) ctx.moveTo(...p); else ctx.lineTo(...p); }));
        ctx.closePath(); ctx.stroke();
      }
      if (this.step === 'clean' && !inLoupe) {
        // vertices where lines/arcs meet
        ctx.fillStyle = '#fff';
        for (const loop of [this.shape.outer, ...this.shape.holes]) for (const s of loop) { const p = S({ x: s.a[0], y: s.a[1] }); ctx.beginPath(); ctx.arc(p[0], p[1], 3.5, 0, 7); ctx.fill(); }
      }
    }
    if (this.seed && this.step === 'trace') {
      const p = st.toScr(this.seed);
      ctx.strokeStyle = '#00e676'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(p[0], p[1], 10, 0, 7); ctx.stroke();
    }
  }

  stepTrace() {
    this.buildCanvasEditor((panel) => {
      const autoBtn = el('button', { class: 'primary' }, '✨ Auto-detect');
      const seedBtn = el('button', {}, '👆 Tap inside part');
      const handBtn = el('button', {}, '✏️ Draw by hand');
      const mode = el('select', {},
        el('option', { value: 'edges' }, 'Find edges (any photo)'),
        el('option', { value: 'dark' }, 'Dark part on light background'),
        el('option', { value: 'light' }, 'Light part on dark background'));
      mode.value = this.job.detectMode || 'edges';
      const sens = el('input', { type: 'range', min: 1, max: 10, step: 1, value: this.job.sensitivity || 5 });
      const tools = el('div', { class: 'toolbar' });
      const chips = el('div', { class: 'chips' });
      const tb = {};
      [['move', '✋ Move'], ['add', '➕ Add'], ['delete', '🗑 Delete'], ['corner', '◆ Corner']].forEach(([id, label]) => {
        tb[id] = el('button', {}, label);
        tb[id].onclick = () => { this.tool = id; this.drawing = false; this.refreshTools(); };
        tools.appendChild(tb[id]);
      });
      const undo = el('button', {}, '↶ Undo');
      const closeBtn = el('button', { class: 'go' }, 'Close shape');
      const next = el('button', { class: 'go' }, 'Next: clean up →');
      undo.onclick = () => this.popUndo();
      closeBtn.onclick = () => this.finishDrawing();
      next.onclick = () => this.go('clean');
      const hints = {
        move: 'Drag points to fix the outline. Pinch to zoom, drag empty space to pan.',
        add: 'Tap on the outline to add a point there.',
        delete: 'Tap a point to delete it.',
        corner: 'Tap a point: sharp corner (yellow square) → smooth (cyan) → automatic.',
        seed: 'Tap inside the part you want, then Auto-detect.',
      };
      this.refreshTools = () => {
        Object.entries(tb).forEach(([id, b]) => b.classList.toggle('on', id === this.tool && !this.drawing));
        handBtn.classList.toggle('on', this.drawing);
        closeBtn.style.display = this.drawing ? '' : 'none';
        this.hintEl.textContent = this.drawing ? 'Tap around the edge, one point at a time. Tap the first point (or Close shape) to finish. Mark sharp corners afterwards with ◆.' : hints[this.tool];
        chips.innerHTML = '';
        const mk = (label, idx) => {
          const b = el('button', { class: idx === this.active ? 'on' : '' }, label);
          b.onclick = () => { this.active = idx; this.drawing = false; this.refreshTools(); this.stage.render(); };
          chips.appendChild(b);
        };
        mk(`Outline (${this.job.contours.outer.length} pts)`, -1);
        this.job.contours.holes.forEach((h, i) => mk(`Cutout ${i + 1}`, i));
        const add = el('button', {}, '+ Cutout');
        add.onclick = () => {
          this.pushUndo();
          this.job.contours.holes.push([]);
          this.active = this.job.contours.holes.length - 1;
          this.drawing = true;
          this.refreshTools();
        };
        chips.appendChild(add);
        if (this.active >= 0) {
          const del = el('button', { class: 'danger' }, 'Remove cutout');
          del.onclick = () => { this.pushUndo(); this.job.contours.holes.splice(this.active, 1); this.active = -1; this.refreshTools(); this.changed(); };
          chips.appendChild(del);
        }
      };
      seedBtn.onclick = () => { this.tool = 'seed'; this.drawing = false; this.refreshTools(); };
      handBtn.onclick = () => {
        this.pushUndo();
        this.setContour([]);
        this.drawing = true;
        this.refreshTools();
        this.changed();
      };
      autoBtn.onclick = async () => {
        this.job.detectMode = mode.value;
        this.job.sensitivity = +sens.value;
        autoBtn.disabled = true;
        autoBtn.textContent = 'Working…';
        try {
          const res = await detectOutline(this.straight.canvas, { mode: mode.value, sensitivity: +sens.value, seed: this.seed });
          if (!res) { toast('No clear outline found. Try “Tap inside part”, another detect mode, or Draw by hand.'); return; }
          this.pushUndo();
          const step = 0.08 * this.straight.ppi; // a point about every 1/12"
          const conv = (pts) => resampleOutline(pts, step).map((q) => this.inch(q));
          this.job.contours.outer = conv(res.outer);
          this.job.contours.holes = res.holes.map(conv).filter((h) => h.length >= 3);
          this.active = -1;
          this.drawing = false;
          this.refreshTools();
          this.changed();
          toast(`Found the outline${res.holes.length ? ` and ${res.holes.length} cutout(s)` : ''}. Check it, then clean up.`);
        } catch (e) {
          toast(e.message);
        } finally {
          autoBtn.disabled = false;
          autoBtn.textContent = '✨ Auto-detect';
        }
      };
      panel.append(
        el('div', { class: 'grid2' }, autoBtn, seedBtn),
        el('label', {}, 'Detect mode'), mode,
        el('label', {}, 'Edge sensitivity'), sens,
        el('div', { class: 'row', style: 'margin-top:10px' }, handBtn, closeBtn),
        chips, tools,
        el('div', { class: 'row', style: 'margin-top:8px' }, undo, next),
      );
      this.refreshTools();
    }, '');
  }

  stepClean() {
    this.buildCanvasEditor((panel) => {
      const m = this.job.mirror;
      const mirrorBtn = el('button', {}, '');
      const keepBtn = el('button', {}, '');
      const center = el('button', {}, '⌖ Find center');
      const smooth = el('input', { type: 'range', min: 0, max: 10, step: 1, value: this.job.smooth });
      const smoothVal = el('span', { class: 'muted' });
      const snap = el('input', { type: 'checkbox' });
      snap.checked = this.job.snap;
      const undo = el('button', {}, '↶ Undo');
      const next = el('button', { class: 'go' }, 'Next: export →');
      const warn = el('div');
      const refresh = () => {
        mirrorBtn.textContent = m.on ? '🪞 Mirror: ON' : '🪞 Mirror: off';
        mirrorBtn.classList.toggle('on', m.on);
        keepBtn.textContent = m.keep === 'left' ? 'Keep: left half' : 'Keep: right half';
        keepBtn.disabled = center.disabled = !m.on;
        smoothVal.textContent = ` ${this.job.smooth} (${['none', 'very light', 'light', 'normal', 'normal', 'medium', 'medium', 'strong', 'strong', 'very strong', 'max'][this.job.smooth]})`;
        this.hintEl.textContent = m.on
          ? 'Drag the pink ⇔ handle to move the centerline. The shaded half is replaced by the mirror image of the other.'
          : 'Orange = clean shape (lines and true arcs). Blue = your trace. Turn on Mirror for symmetric parts.';
      };
      mirrorBtn.onclick = () => {
        this.pushUndo();
        m.on = !m.on;
        if (m.on && m.cx == null) m.cx = autoCenter(this.job.contours.outer);
        refresh(); this.changed();
      };
      keepBtn.onclick = () => { this.pushUndo(); m.keep = m.keep === 'left' ? 'right' : 'left'; refresh(); this.changed(); };
      center.onclick = () => { this.pushUndo(); m.cx = autoCenter(this.job.contours.outer); toast('Centerline moved to the best match'); this.changed(); };
      smooth.oninput = () => { this.job.smooth = +smooth.value; refresh(); this.changed(); };
      snap.onchange = () => { this.job.snap = snap.checked; this.changed(); };
      undo.onclick = () => { this.popUndo(); refresh(); };
      next.onclick = () => this.go('export');
      const origUpdate = this.updateBadges;
      this.updateBadges = () => {
        origUpdate();
        const w = this.shape?.warnings || [];
        warn.className = w.length ? 'note' : '';
        warn.textContent = w.join(' ');
        if (this.shape) {
          const all = [this.shape.outer, ...this.shape.holes].flat();
          const nl = all.filter((s) => s.type === 'line').length, na = all.length - nl;
          this.hintEl.textContent = `${nl} lines + ${na} arcs. ` + (m.on ? 'Drag the pink ⇔ handle to move the centerline.' : 'Orange = clean shape. Blue = your trace.');
        }
      };
      panel.append(
        el('div', { class: 'grid2' }, mirrorBtn, keepBtn),
        center,
        el('label', {}, 'Smoothing', smoothVal), smooth,
        el('label', { class: 'check' }, snap, 'Snap near-straight edges to level / plumb'),
        warn,
        el('div', { class: 'row' }, undo, next),
      );
      refresh();
    }, '');
  }

  // ---------------------------------------------------------------- step 6: export
  stepExport() {
    this.rebuild();
    const page = el('div', { class: 'page' });
    const s = this.settings;
    if (!this.shape || !this.shape.outer.length) {
      page.append(el('div', { class: 'bad-box' }, 'No clean shape yet. Go back to Trace.'));
      this.view.appendChild(page);
      return;
    }
    const bb = shapeBBox(this.shape);
    const d = s.denom;
    const prev = renderShapePNG(this.shape, { name: this.job.name, denom: d, width: 900 });
    const name = el('input', { value: this.job.fileName || safeFileName(this.job.name || 'shape') });
    const ver = el('select', {}, el('option', { value: 'R2000' }, 'DXF 2000 (units stored as inches)'), el('option', { value: 'R12' }, 'DXF R12 (oldest, most compatible)'));
    ver.value = this.job.dxfVersion || s.dxfVersion;
    const result = el('div');
    const dl = el('button', { class: 'go' }, '⬇ Download DXF');
    const share = el('button', {}, '📤 Share DXF');
    const png = el('button', {}, '🖼 Save PNG with dimensions');
    const build = () => {
      this.job.fileName = name.value; this.job.dxfVersion = ver.value; this.save();
      const text = writeDXF(this.shape, { version: ver.value, layerOuter: s.layerOuter, layerHole: s.layerHole });
      const chk = checkDXF(text);
      showCheck(result, chk, d);
      return { text, chk, file: safeFileName(name.value || 'shape') + '.dxf' };
    };
    build();
    name.oninput = ver.onchange = () => build();
    dl.onclick = () => {
      const { text, chk, file } = build();
      if (!chk.ok && !confirm('The self-check found a problem (see below). Download anyway?')) return;
      downloadBlob(new Blob([text], { type: 'application/dxf' }), file);
    };
    share.onclick = async () => {
      const { text, file } = build();
      const ok = await shareFile(new File([text], file, { type: 'application/dxf' }), 'DXF for Mozaik');
      if (!ok) downloadBlob(new Blob([text], { type: 'application/dxf' }), file);
    };
    png.onclick = async () => {
      const c = renderShapePNG(this.shape, { name: this.job.name, denom: d, width: 1800, footer: true });
      downloadBlob(await canvasToBlob(c, 'image/png'), safeFileName(name.value || 'shape') + '.png');
    };
    const cad = toCadSpace(this.shape);
    page.append(
      el('h2', {}, `${formatInches(bb.w, d)} wide × ${formatInches(bb.h, d)} tall`),
      el('img', { class: 'preview-img', src: prev.toDataURL('image/png'), alt: 'Shape preview' }),
      el('div', { class: 'note' }, ACCURACY_NOTE + (this.job.aspectGuess ? ' Only one side of the reference rectangle was entered, so the other direction is a photo estimate.' : '')),
      el('label', {}, 'File name'), name,
      el('label', {}, 'DXF format'), ver,
      el('div', { class: 'stack', style: 'margin-top:12px' }, dl, share, png),
      el('h3', {}, 'Self-check (the file is re-opened and tested)'), result,
      el('h3', {}, 'In Mozaik'),
      el('p', { class: 'small' }, `Part Editor → DXF In → pick this file. Lower-left corner is at 0,0. Outline on layer “${s.layerOuter}”` +
        (cad.holes.length ? `, ${cad.holes.length} cutout(s) on layer “${s.layerHole}”.` : '.')),
    );
    this.view.appendChild(page);
  }

  nearest(screenPts, sp, maxD) {
    let best = -1, bd = maxD;
    screenPts.forEach((q, i) => { const d = Math.hypot(q[0] - sp[0], q[1] - sp[1]); if (d < bd) { bd = d; best = i; } });
    return best;
  }
}

function showCheck(box, chk, denom) {
  box.innerHTML = '';
  const li = (ok, text) => el('li', {}, (ok ? '✅ ' : '❌ ') + text);
  box.className = chk.ok ? 'ok-box' : 'bad-box';
  box.append(el('ul', { class: 'checks' },
    li(chk.closedLoops === chk.loops, `${chk.loops} contour(s), all closed`),
    li(chk.kinds.every((k) => k === 'LINE' || k === 'ARC'), `Only lines and arcs (${chk.lines} lines, ${chk.arcs} arcs, no splines)`),
    li(chk.version === 'AC1009' || chk.insunits === 1, chk.version === 'AC1015' ? 'Units: inches ($INSUNITS = 1)' : 'R12 file: no units field, all values are inches'),
    li(!chk.problems.some((p) => p.includes('Lower-left')), 'Lower-left corner at 0,0'),
    li(true, `Size in file: ${formatInches(chk.width, denom)} × ${formatInches(chk.height, denom)}`),
  ));
  if (chk.problems.length) box.append(el('p', {}, chk.problems.join(' ')));
}

const sub2 = (a, b) => [a[0] - b[0], a[1] - b[1]];
function segDist(p, a, b) {
  const ab = sub2(b, a), l2 = ab[0] * ab[0] + ab[1] * ab[1];
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t);
}

function thumbOf(canvas) {
  const c = document.createElement('canvas');
  const k = 160 / Math.max(canvas.width, canvas.height);
  c.width = Math.round(canvas.width * k); c.height = Math.round(canvas.height * k);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
}

// Clean shape drawn to scale on white with overall dimensions (for the export preview and the PNG record).
export function renderShapePNG(shape, { name = '', denom = 16, width = 1200, footer = false } = {}) {
  const cad = toCadSpace(shape); // y up, lower-left at 0,0
  const bb = shapeBBox(cad);
  const margin = width * 0.12;
  const k = (width - 2 * margin) / Math.max(bb.w, bb.h * 0.75);
  const W = width, H = Math.round(bb.h * k + 2 * margin + (footer ? 70 : 0));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  const ox = (W - bb.w * k) / 2;
  const T = (p) => [ox + p[0] * k, margin + (bb.h - p[1]) * k];
  ctx.beginPath();
  for (const loop of [cad.outer, ...cad.holes]) {
    loop.forEach((s, i) => segPoints(s, 0.02).forEach((q, j) => { const p = T(q); if (i === 0 && j === 0) ctx.moveTo(...p); else ctx.lineTo(...p); }));
    ctx.closePath();
  }
  ctx.fillStyle = '#ffe8d6'; ctx.fill('evenodd');
  ctx.strokeStyle = '#000'; ctx.lineWidth = Math.max(2, width / 500); ctx.stroke();
  // dimension lines
  const fs = Math.round(width / 32);
  ctx.font = `bold ${fs}px system-ui, sans-serif`;
  ctx.fillStyle = '#000'; ctx.strokeStyle = '#000'; ctx.lineWidth = Math.max(1, width / 900);
  const [x0, yb] = T([0, 0]), [x1, yt] = T([bb.w, bb.h]);
  const dy = yb + margin * 0.45;
  ctx.beginPath(); ctx.moveTo(x0, yb + 6); ctx.lineTo(x0, dy + 10); ctx.moveTo(x1, yb + 6); ctx.lineTo(x1, dy + 10);
  ctx.moveTo(x0, dy); ctx.lineTo(x1, dy); ctx.stroke();
  arrow(ctx, x0, dy, -1, 0, fs * 0.5); arrow(ctx, x1, dy, 1, 0, fs * 0.5);
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillText(formatInches(bb.w, denom), (x0 + x1) / 2, dy - 6);
  const dx = x1 + margin * 0.35;
  ctx.beginPath(); ctx.moveTo(x1 + 6, yb); ctx.lineTo(dx + 10, yb); ctx.moveTo(x1 + 6, yt); ctx.lineTo(dx + 10, yt);
  ctx.moveTo(dx, yb); ctx.lineTo(dx, yt); ctx.stroke();
  arrow(ctx, dx, yb, 0, 1, fs * 0.5); arrow(ctx, dx, yt, 0, -1, fs * 0.5);
  ctx.save(); ctx.translate(dx - 8, (yb + yt) / 2); ctx.rotate(-Math.PI / 2); ctx.textBaseline = 'bottom';
  ctx.fillText(formatInches(bb.h, denom), 0, 0); ctx.restore();
  // radius labels for arcs (outline only, largest few)
  const arcs = cad.outer.filter((s) => s.type === 'arc').map((s) => ({ s, g: arcGeom(s) })).filter((a) => a.g).sort((a, b) => b.g.r * b.g.sweep - a.g.r * a.g.sweep).slice(0, 4);
  ctx.font = `${Math.round(fs * 0.7)}px system-ui, sans-serif`; ctx.fillStyle = '#7a2e00';
  const seen = new Set();
  for (const { s, g } of arcs) {
    const key = g.r.toFixed(2);
    if (seen.has(key)) continue;
    seen.add(key);
    const [mx, my] = T(s.m);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(`R ${formatInches(g.r, denom)}`, mx, my + (my < (yt + yb) / 2 ? -fs * 0.6 : fs * 0.6));
  }
  if (footer) {
    ctx.fillStyle = '#333'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.font = `bold ${Math.round(fs * 0.75)}px system-ui, sans-serif`;
    ctx.fillText(`${name || 'Shape'} · ${new Date().toLocaleDateString()}`, 20, H - 40);
    ctx.font = `${Math.round(fs * 0.6)}px system-ui, sans-serif`;
    ctx.fillText('Measured from a photo: an estimate. Check one real edge before cutting.', 20, H - 12);
  }
  return c;
}

function arrow(ctx, x, y, ux, uy, size) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - ux * size - uy * size * 0.4, y - uy * size + ux * size * 0.4);
  ctx.lineTo(x - ux * size + uy * size * 0.4, y - uy * size - ux * size * 0.4);
  ctx.closePath(); ctx.fill();
}

export { dist };
