// Mode 1: photo -> perspective fix -> scale -> trace -> mirror/cleanup -> DXF for Mozaik "DXF In".
import {
  parseInches, formatInches, orderCorners, quadAspect, buildShape, shapeBBox, segPoints, writeDXF, checkDXF,
  autoCenter, dist, toCadSpace, arcGeom, CUT_TYPES, bitsFor, DEFAULT_DEPTH, DEFAULT_BIT, layerFor, openAllowed,
  homography, applyH,
} from './core.js';
import { loadPhoto, canvasToBlob, straighten, findQuad, detectOutline, resampleOutline, resampleLine, detectDetails, detailAt, freeDetailEdges } from './vision.js';
import { suggestDetails, locatePart } from './claude.js';
import { Stage } from './stage.js';
import { saveJob, getJob } from './store.js';
import { el, toast, downloadBlob, shareFile, safeFileName, ACCURACY_NOTE } from './ui.js';

const STEPS = [
  ['photo', 'Photo'], ['corners', 'Corners'], ['size', 'Size'], ['trace', 'Outline'], ['details', 'Details'], ['clean', 'Clean'], ['export', 'Export'],
];
// the automatic way: you give the photo and the size, Claude and the photo do the rest
const AUTO_STEPS = [['photo', 'Photo'], ['size', 'Size'], ['result', 'What I found'], ['export', 'Export']];

export async function openShapeEditor(view, job, settings, { onTitle, onOpenJob }) {
  const ed = new ShapeEditor(view, job, settings, onTitle);
  ed.onOpenJob = onOpenJob;
  await ed.init();
  return ed;
}

class ShapeEditor {
  constructor(view, job, settings, onTitle) {
    this.view = view; this.job = job; this.settings = settings; this.onTitle = onTitle;
    job.contours ||= { outer: [] };
    // older jobs kept cutouts as plain holes; now every interior shape is a feature with a cut type
    job.features ||= (job.contours.holes || []).filter((h) => h.length >= 3).map((pts) => ({ pts, closed: true, cut: 'inside', src: 'hand' }));
    delete job.contours.holes;
    job.hiddenLayers ||= {};
    job.detailSens ??= 5;
    job.minFeature ??= 0.75;
    job.mirror ||= { on: false, cx: null, keep: 'left' };
    job.smooth ??= 3;
    job.snap ??= true;
    job.corners ||= [];
    // jobs traced by hand before the automatic way existed stay manual
    job.mode ||= job.corners.length || job.contours.outer.length ? 'manual' : 'auto';
    this.tool = 'move';
    this.active = -1; // -1 = outline, 0.. = index into job.features
    this.drawing = false;
    this.undo = [];
    this.shape = null;
    this.seed = null;
  }

  async init() {
    window.__editor = this; // handy for automated tests
    if (this.job.photo) this.photo = await loadPhoto(this.job.photo);
    if (this.photo && this.job.corners.length === 4 && this.job.rectIn) this.restraighten();
    const steps = this.steps().map((x) => x[0]);
    const auto = this.job.mode === 'auto';
    const fallback = !this.photo ? 'photo' : auto ? (this.canGo('result') ? 'result' : 'size') : this.straight ? 'trace' : 'corners';
    this.go(this.job.step && steps.includes(this.job.step) && this.canGo(this.job.step) ? this.job.step : fallback);
  }

  destroy() { if (this.stage) this.stage.destroy(); freeDetailEdges(this.found); }

  steps() { return this.job.mode === 'auto' ? AUTO_STEPS : STEPS; }

  canGo(step) {
    if (step === 'photo') return true;
    if (step === 'size' && this.job.mode === 'auto') return !!this.photo;
    if (step === 'result') return !!this.straight && this.job.contours.outer.length >= 3;
    if (step === 'corners') return !!this.photo;
    if (step === 'size') return this.photo && this.job.corners.length === 4;
    if (step === 'trace') return !!this.straight;
    if (step === 'details' || step === 'clean') return !!this.straight && this.job.contours.outer.length >= 3;
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
    window.scrollTo(0, 0);
    const bar = el('nav', { class: 'steps' });
    const list = this.steps();
    const order = list.map((s) => s[0]);
    list.forEach(([id, label]) => {
      const b = el('button', { class: (id === step ? 'current ' : '') + (order.indexOf(id) < order.indexOf(step) ? 'done' : '') }, label);
      b.disabled = !this.canGo(id);
      b.onclick = () => this.go(id);
      bar.appendChild(b);
    });
    // switch between the automatic way and doing it by hand
    if (this.job.mode === 'auto') {
      if (this.canGo('result')) {
        const hand = el('button', { class: 'mode-switch' }, '✏️ Fix by hand');
        hand.onclick = () => { this.job.mode = 'manual'; this.go('details'); };
        bar.appendChild(hand);
      }
    } else {
      const auto = el('button', { class: 'mode-switch' }, '✨ Automatic');
      auto.onclick = () => { this.job.mode = 'auto'; this.go(this.canGo('result') ? 'result' : 'size'); };
      bar.prepend(auto);
    }
    this.view.appendChild(bar);
    if (this.job.parent) this.view.appendChild(this.taskBanner());
    ({ photo: () => this.stepPhoto(), corners: () => this.stepCorners(), size: () => this.stepSize(), trace: () => this.stepTrace(),
      details: () => this.stepDetails(), clean: () => this.stepClean(), export: () => this.stepExport(), result: () => this.stepResult() })[step]();
    bar.querySelector('.current')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }

  // ---------------------------------------------------------------- tracing a part flagged on a build sheet
  // A strip above every step: what to trace (close-up), and the way back to the build sheet.
  taskBanner() {
    const t = this.job.parent;
    const big = !!this.bannerOpen;
    const img = t.crop ? el('img', { class: 'task-crop' + (big ? ' big' : ''), src: t.crop, alt: 'The part to trace', title: 'Tap to enlarge' }) : '';
    if (img) img.onclick = () => { this.bannerOpen = !this.bannerOpen; img.classList.toggle('big', this.bannerOpen); };
    const back = el('button', { class: 'task-back', 'aria-label': `Back to ${t.jobName}` }, '← Back');
    back.onclick = () => this.backToParent();
    return el('div', { class: 'task-banner no-print' }, img,
      el('div', { class: 'task-text' },
        el('div', { class: 'task-title' }, (this.job.parentDone ? '✓ ' : '') + `Tracing ${t.label} for ${t.jobName}`),
        t.description ? el('div', { class: 'small task-desc' }, t.description) : ''),
      back);
  }

  async backToParent() {
    const t = this.job.parent;
    clearTimeout(this.saveT);
    await saveJob(this.job).catch(() => {});
    if (this.onOpenJob) this.onOpenJob(t.jobId, { focusDecor: t.decorId });
  }

  // a DXF was saved: tick the part off on the build sheet
  async markParentDone(file) {
    const t = this.job.parent;
    if (!t) return;
    const bb = shapeBBox({ outer: this.shape.outer, holes: [] });
    try {
      const cab = await getJob(t.jobId);
      const part = cab?.result?.decor?.find((d) => d.id === t.decorId);
      if (part) {
        part.dxf = { file, w: bb.w, h: bb.h, at: Date.now() };
        part.shapeJobId = this.job.id;
        await saveJob(cab);
      }
    } catch { /* the build sheet was deleted: nothing to tick */ }
    this.job.parentDone = true;
    this.save();
    if (this.doneBox) this.doneBox.style.display = '';
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
      this.go(this.job.mode === 'auto' ? 'size' : 'corners');
    };
    cam.onchange = () => onFile(cam);
    pick.onchange = () => onFile(pick);
    page.append(el('div', { class: 'stack' }, take, up), cam, pick);
    if (this.photo) {
      const keep = el('button', { class: 'go' }, 'Keep current photo →');
      keep.onclick = () => this.go(this.job.mode === 'auto' ? 'size' : 'corners');
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
        ? (this.job.parent?.box && n === 0
          ? 'Purple = the part to trace. Tap 4 corners of a rectangle beside it whose size you know (a cabinet face, or the part itself).'
          : `Tap corner ${n + 1} of 4 of something truly rectangular. Pinch to zoom for accuracy.`)
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
        const pb = this.job.parent?.box;
        if (pb) {
          // where the part to trace is in the photo
          const a = st.toScr([pb.x0 * this.photo.width, pb.y0 * this.photo.height]), b = st.toScr([pb.x1 * this.photo.width, pb.y1 * this.photo.height]);
          ctx.save(); ctx.setLineDash([8, 6]); ctx.lineWidth = 3; ctx.strokeStyle = '#c04fd6';
          ctx.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
          ctx.setLineDash([]); ctx.fillStyle = '#9c27b0'; ctx.font = 'bold 13px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
          const lab = 'Part to trace';
          ctx.fillRect(a[0], a[1] - 20, ctx.measureText(lab).width + 12, 20);
          ctx.fillStyle = '#fff'; ctx.fillText(lab, a[0] + 6, a[1] - 4);
          ctx.restore();
        }
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
    const pb = this.job.parent?.box;
    if (pb && !this.job.corners.length) {
      // start zoomed on the part, with room around it for a reference rectangle
      const W = this.photo.width, H = this.photo.height, bw = (pb.x1 - pb.x0) * W, bh = (pb.y1 - pb.y0) * H, m = Math.max(bw, bh) * 0.6;
      this.stage.fit({ x: pb.x0 * W - m, y: pb.y0 * H - m, w: bw + 2 * m, h: bh + 2 * m });
    }
    refresh();
  }

  // ---------------------------------------------------------------- step 3: size
  stepSize() {
    if (this.job.mode === 'auto') return this.stepSizeAuto();
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

  // ---------------------------------------------------------------- the automatic way
  stepSizeAuto() {
    const page = el('div', { class: 'page' });
    const rect = this.job.rectIn;
    const w = el('input', { inputmode: 'text', placeholder: 'e.g. 15 3/4', value: this.job.realW || '', 'aria-label': 'Width' });
    const h = el('input', { inputmode: 'text', placeholder: 'e.g. 28', value: this.job.realH || '', 'aria-label': 'Height' });
    const msg = el('div');
    const go = el('button', { class: 'go' }, '✨ Find the part and its details');
    const status = el('div', { class: 'auto-status' });
    const t = this.job.parent;
    const manual = el('button', { class: 'linkish' }, 'Or do it by hand: tap the corners yourself');
    manual.onclick = () => { this.job.mode = 'manual'; this.go('corners'); };
    page.append(
      el('h2', {}, t ? `How big is ${t.label.replace(/^D\d+\s*/, 'the ').toLowerCase()}?` : 'How big is the part?'),
      el('p', {}, 'Measure the part with a tape: its overall width (left to right) and height (top to bottom), in inches. Fractions are fine (14 3/4). That’s all you need to enter.'),
      el('div', { class: 'grid2' }, el('div', {}, el('label', {}, 'Width (inches)'), w), el('div', {}, el('label', {}, 'Height (inches)'), h)),
      el('img', { class: 'preview-img', src: this.photo.toDataURL('image/jpeg', 0.6), alt: 'Your photo' }),
      msg, go, status,
      manual,
      el('p', { class: 'small muted' }, this.settings.apiKey
        ? 'Claude finds the part in the photo and works out what each detail is. The photo goes from this phone straight to Anthropic.'
        : 'No Claude key yet (Settings ⚙): the app will still find a rectangular part and its details, but can’t tell what each detail is or handle shaped parts as well.'),
    );
    const check = () => {
      const W = parseInches(w.value), H = parseInches(h.value);
      msg.className = ''; msg.textContent = '';
      if (w.value && !(W > 0)) { msg.className = 'bad-box'; msg.textContent = 'Can’t read the width. Try 14 3/4 or 14.75'; }
      else if (h.value && !(H > 0)) { msg.className = 'bad-box'; msg.textContent = 'Can’t read the height. Try 22 1/2 or 22.5'; }
      go.disabled = !(W > 0 && H > 0);
      return { W, H };
    };
    w.oninput = h.oninput = check;
    check();
    go.onclick = async () => {
      const { W, H } = check();
      this.job.realW = w.value; this.job.realH = h.value;
      go.disabled = true;
      try {
        await this.autoRun(W, H, (line) => { status.append(el('p', {}, line)); });
        this.go('result');
      } catch (e) {
        status.append(el('div', { class: 'bad-box' }, e.message || String(e)));
        go.disabled = false;
      }
    };
    this.view.appendChild(page);
    if (!rect) setTimeout(() => w.focus(), 50);
  }

  // Photo + size -> corners, straightened photo, outline, details and cut types. say(line): progress.
  async autoRun(W, H, say = () => {}) {
    const notes = [];
    const key = this.settings.apiKey;
    const pw = this.photo.width, ph = this.photo.height;
    let corners = null, info = null;
    say('🔎 Finding the part in the photo…');
    if (key) {
      const k = Math.min(1, 1568 / Math.max(pw, ph));
      const c = document.createElement('canvas');
      c.width = Math.round(pw * k); c.height = Math.round(ph * k);
      c.getContext('2d').drawImage(this.photo, 0, 0, c.width, c.height);
      const t = this.job.parent;
      const hint = t ? `${t.label.replace(/^D\d+\s*/, '')}${t.description ? ` (${t.description})` : ''}` +
        (t.box ? `. It is roughly in the area from x=${t.box.x0.toFixed(2)} to ${t.box.x1.toFixed(2)} and y=${t.box.y0.toFixed(2)} to ${t.box.y1.toFixed(2)} of the photo.` : '') : '';
      info = await locatePart({ apiKey: key, model: this.settings.model, imageBase64: c.toDataURL('image/jpeg', 0.85).split(',')[1], widthIn: formatInches(W, 16, ''), heightIn: formatInches(H, 16, ''), hint });
      if (!info.found || !Array.isArray(info.corners) || info.corners.length !== 4) {
        throw new Error('Claude couldn’t find the part in this photo. ' + (info.warnings || []).join(' ') + ' Try a photo with the whole part in view, or tap ✏️ Fix by hand.');
      }
      corners = info.corners.map((q) => [Math.min(1, Math.max(0, q.x)) * pw, Math.min(1, Math.max(0, q.y)) * ph]);
      for (const wmsg of info.warnings || []) notes.push(wmsg);
      if (info.rectangular) {
        // Claude's corners are close; the part's own edges in the photo are exact
        const q = await findQuad(this.photo, corners);
        if (q) corners = q; else notes.push('The corners are Claude’s estimate (the part’s edges weren’t clear enough to lock on to). Check the outline against the photo.');
      }
    } else {
      corners = await findQuad(this.photo, null);
      if (!corners) throw new Error('Couldn’t find a four-sided part in the photo. Add a Claude key in Settings (⚙) so Claude can find it, or tap ✏️ Fix by hand.');
    }
    this.job.corners = orderCorners(corners);
    this.job.rectIn = { W, H };
    this.job.aspectGuess = false;
    this.restraighten();
    say('📐 Straightened the photo to your size.');

    // outline: a rectangle, or the shape inside its rectangle
    const rectOutline = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }].map((q) => ({ ...q, corner: true }));
    let outer = rectOutline, shaped = false;
    const wantShape = info ? !info.rectangular : true;
    if (wantShape) {
      const Hm = homography(this.job.corners, [[0, 0], [W, 0], [W, H], [0, H]]);
      const ip = info?.inside_point ? applyH(Hm, info.inside_point.x * pw, info.inside_point.y * ph) : [W / 2, H / 2];
      const seed = this.px({ x: Math.min(W, Math.max(0, ip[0])), y: Math.min(H, Math.max(0, ip[1])) });
      try {
        const res = await detectOutline(this.straight.canvas, { mode: 'edges', sensitivity: 5, seed });
        if (res) {
          const pts = resampleOutline(res.outer, 0.08 * this.straight.ppi).map((q) => this.inch(q));
          const b = ptsBBox(pts), a = Math.abs(polyArea(pts));
          const fits = b.w > W * 0.8 && b.w < W * 1.12 && b.h > H * 0.8 && b.h < H * 1.12;
          // a shaped part fills noticeably less than its rectangle; otherwise it's a rectangle after all
          if (fits && (info ? true : a < W * H * 0.93)) {
            // your tape measure beats the photo: stretch the trace to exactly the size you entered
            const sx = W / b.w, sy = H / b.h;
            outer = pts.map((q) => ({ x: (q.x - b.minX) * sx, y: (q.y - b.minY) * sy }));
            shaped = true;
          }
          else if (info) notes.push('Couldn’t trace the shaped outline cleanly, so the outline is the part’s overall rectangle. Use ✏️ Fix by hand to trace it.');
        } else if (info) notes.push('Couldn’t trace the shaped outline, so the outline is the part’s overall rectangle. Use ✏️ Fix by hand to trace it.');
      } catch (e) { notes.push('Outline tracing failed: ' + e.message); }
    }
    this.job.contours.outer = outer;
    this.job.features = [];
    say(shaped ? '✏️ Traced the shaped outline.' : '▭ Outline: a rectangle, exactly your size.');

    say('🔍 Looking for details inside…');
    const n = await this.findDetails(true);
    say(`Found ${n} detail${n === 1 ? '' : 's'} in the photo.`);
    if (key) {
      say('🤖 Asking Claude what each detail is…');
      try {
        const res = await this.suggestWithClaude();
        for (const wmsg of res.warnings || []) notes.push(wmsg);
        this.job.claudeSummary = res.summary || info?.summary || '';
      } catch (e) { notes.push('Claude couldn’t check the details: ' + e.message); }
    } else if (!key) notes.push('Cut types are the app’s guesses from the photo. With a Claude key, Claude checks each one and adds details the photo detection missed.');
    this.job.partName = info?.part || '';
    this.job.autoNotes = notes;
    this.job.mirror = { on: false, cx: null, keep: 'left' };
    this.undo = [];
    this.rebuild();
    this.save();
  }

  // What the automatic way found, drawn on the straightened photo, with a plain list. Accept or fix.
  stepResult() {
    this.rebuild();
    const page = el('div', { class: 'page' });
    const d = this.settings.denom;
    const bb = this.shape ? shapeBBox({ outer: this.shape.outer, holes: [] }) : ptsBBox(this.job.contours.outer);
    const wrap = el('div', { class: 'stage-wrap export-stage' });
    const legend = el('div');
    const refresh = () => { legend.replaceChildren(this.legendEl()); };
    this.onLegend = refresh;
    const list = el('div', { class: 'found-list' });
    const fsize = (pts) => { const b = ptsBBox(pts); return `${formatInches(b.w, d)} × ${formatInches(b.h, d)}`; };
    list.append(el('div', { class: 'feat-row' }, el('span', { class: 'dot', style: `background:${CUT_TYPES.outside.color}` }),
      el('span', { class: 'grow' }, el('b', {}, 'Outline · Outside cut'), ` ${formatInches(bb.w, d)} × ${formatInches(bb.h, d)}`, el('div', { class: 'small muted' }, this.job.contours.outer.length === 4 ? 'Rectangle, your exact size.' : 'Shaped outline traced from the photo.'))));
    this.job.features.forEach((f, i) => {
      const t = CUT_TYPES[f.cut] || CUT_TYPES.skip;
      const extra = [t.depth && f.depth ? `${formatInches(f.depth, 16)} deep` : '', t.bit && f.bit ? (bitsFor(f.cut).find((b) => b.id === f.bit)?.label || f.bit) : ''].filter(Boolean).join(', ');
      list.append(el('div', { class: 'feat-row' }, el('span', { class: 'dot', style: `background:${t.color}` }),
        el('span', { class: 'grow' }, el('b', {}, `#${i + 1} · ${t.label}`), ` ${fsize(f.pts)}${f.closed === false ? ' line' : ''}${extra ? ` · ${extra}` : ''}`,
          f.why ? el('div', { class: 'small muted' }, f.why) : '')));
    });
    const ok = el('button', { class: 'go' }, '✓ Looks right: get the DXF →');
    ok.onclick = () => this.go('export');
    const fix = el('button', {}, '✏️ Fix something');
    fix.onclick = () => { this.job.mode = 'manual'; this.go('details'); };
    const again = el('button', {}, '↻ Find it again');
    again.onclick = () => this.go('size');
    const notes = this.job.autoNotes || [];
    page.append(
      el('h2', {}, `${this.job.partName ? this.job.partName[0].toUpperCase() + this.job.partName.slice(1) + ': ' : ''}${formatInches(bb.w, d)} wide × ${formatInches(bb.h, d)} tall`),
      this.job.claudeSummary ? el('p', {}, this.job.claudeSummary) : '',
      el('p', { class: 'small muted' }, 'This is what will be cut, drawn over your photo. Numbers match the list below. Tap a layer to hide or show it.'),
      wrap, legend,
      el('h3', {}, `What I found (${this.job.features.length + 1})`), list,
      notes.length ? el('div', { class: 'note' }, el('b', {}, 'Check: '), notes.join(' ')) : '',
      el('div', { class: 'stack', style: 'margin-top:12px' }, ok, fix, again),
      el('div', { class: 'note' }, ACCURACY_NOTE),
    );
    this.view.appendChild(page);
    refresh();
    this.stage = new Stage(wrap, { draw: (ctx, st, inLoupe) => this.drawOverlay(ctx, st, inLoupe) });
    this.stage.setImage(this.straight.canvas);
    const pts = this.job.contours.outer.map((q) => this.px(q));
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    this.stage.fit({ x: Math.min(...xs) - 20, y: Math.min(...ys) - 20, w: Math.max(...xs) - Math.min(...xs) + 40, h: Math.max(...ys) - Math.min(...ys) + 40 });
  }

  restraighten() {
    const { W, H } = this.job.rectIn;
    this.straight = straighten(this.photo, this.job.corners, W, H);
  }

  // inches <-> straightened-canvas px
  px(p) { const s = this.straight; return [(p.x - s.ox) * s.ppi, (p.y - s.oy) * s.ppi]; }
  inch(q) { const s = this.straight; return { x: q[0] / s.ppi + s.ox, y: q[1] / s.ppi + s.oy }; }

  contour(i = this.active) { return i < 0 ? this.job.contours.outer : this.job.features[i]?.pts; }
  setContour(pts, i = this.active) { if (i < 0) this.job.contours.outer = pts; else if (this.job.features[i]) this.job.features[i].pts = pts; }
  isClosed(i = this.active) { return i < 0 || this.job.features[i]?.closed !== false; }

  pushUndo() {
    this.undo.push(JSON.stringify({ c: this.job.contours, f: this.job.features, m: this.job.mirror }));
    if (this.undo.length > 40) this.undo.shift();
  }
  popUndo() {
    const s = this.undo.pop();
    if (!s) { toast('Nothing to undo'); return; }
    const o = JSON.parse(s);
    this.job.contours = o.c; this.job.features = o.f || []; this.job.mirror = o.m;
    if (this.active >= this.job.features.length) this.active = -1;
    this.refreshTools && this.refreshTools();
    this.changed();
  }

  rebuild() {
    const raw = { outer: this.job.contours.outer, features: this.job.features };
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
    const run = () => { this.rebuild(); this.updateBadges && this.updateBadges(); if (this.step === 'trace') this.refreshTools && this.refreshTools(); this.stage && this.stage.render(); };
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
        // (in Details, nothing picked means nothing to drag: the outline belongs to the Outline step)
        if (this.tool === 'move' && !(this.step === 'details' && this.active < 0)) {
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
    const closed = this.isClosed();
    if (this.drawing) {
      if (closed && c.length >= 3 && Math.hypot(...sub2(st.toScr(this.px(c[0])), sp)) < 28) { this.finishDrawing(); return; }
      this.pushUndo();
      c.push({ x: q.x, y: q.y });
      this.setContour(c);
      this.changed();
      return;
    }
    if (this.tool === 'select') { this.selectAt(p, st); return; }
    if (this.tool === 'region') { this.addRegionAt(p); return; }
    if (this.tool === 'add') {
      if (c.length < 2) return;
      // insert on the nearest edge
      let best = -1, bd = Infinity;
      const edges = closed ? c.length : c.length - 1;
      for (let i = 0; i < edges; i++) {
        const a = st.toScr(this.px(c[i])), b = st.toScr(this.px(c[(i + 1) % c.length]));
        const d = segDist(sp, a, b);
        if (d < bd) { bd = d; best = i; }
      }
      if (bd > 40) { toast('Tap closer to the line to add a point there'); return; }
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
    } else if (this.step === 'details') {
      this.selectAt(p, st); // in Details, a tap on empty space or another shape picks it
    }
  }

  // Picks the interior shape under a tap: the nearest line within reach, else the smallest area around the point.
  selectAt(p, st) {
    const sp = st.toScr(p);
    let best = -1, bd = 26;
    this.job.features.forEach((f, i) => {
      if (this.isHidden(f)) return;
      const pts = f.pts.map((r) => st.toScr(this.px(r)));
      const n = f.closed === false ? pts.length - 1 : pts.length;
      for (let k = 0; k < n; k++) { const d = segDist(sp, pts[k], pts[(k + 1) % pts.length]); if (d < bd) { bd = d; best = i; } }
    });
    if (best < 0) {
      const q = this.inch(p);
      let area = Infinity;
      this.job.features.forEach((f, i) => {
        if (f.closed === false || this.isHidden(f) || !inPoly([q.x, q.y], f.pts)) return;
        const a = polyArea(f.pts);
        if (a < area) { area = a; best = i; }
      });
    }
    this.active = best;
    this.refreshTools && this.refreshTools();
    this.stage.render();
  }

  async addRegionAt(p) {
    try {
      if (!this.found) await this.findDetails(false);
      const pts = this.found && await detailAt(this.found, p);
      if (!pts || pts.length < 8) { toast('No closed edge around that spot. Draw it with ✏️ instead, or raise the sensitivity.'); return; }
      this.pushUndo();
      const step = 0.08 * this.straight.ppi;
      this.job.features.push({ pts: resampleOutline(pts, step).map((r) => this.inch(r)), closed: true, cut: 'pocket', depth: DEFAULT_DEPTH.pocket, src: 'tap' });
      this.active = this.job.features.length - 1;
      this.tool = 'select';
      this.refreshTools && this.refreshTools();
      this.changed();
      toast('Added. Pick its cut type below.');
    } catch (e) { toast(e.message); }
  }

  finishDrawing() {
    this.drawing = false;
    const c = this.contour();
    const need = this.isClosed() ? 3 : 2;
    if (!c || c.length < need) { toast(`Need at least ${need} points`); return; }
    toast(this.isClosed() ? 'Shape closed' : 'Line finished');
    this.refreshTools && this.refreshTools();
    this.changed();
  }

  isHidden(f) {
    const name = f.cut === 'outside' ? 'OUTSIDE_CUT' : layerFor(f) || 'NOT_CUT';
    return !!this.job.hiddenLayers[name];
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
    // traced outline and interior shapes (thin), colored by cut type
    const colorOf = (f) => (f ? CUT_TYPES[f.cut]?.color || '#888' : CUT_TYPES.outside.color);
    const items = [{ pts: this.job.contours.outer, f: null, k: -1 }, ...this.job.features.map((f, k) => ({ pts: f.pts, f, k }))];
    const editing = this.step === 'trace' || this.step === 'details';
    for (const { pts: c, f, k } of items) {
      if (!c || !c.length) continue;
      if (f && (this.step === 'trace' || this.isHidden(f))) continue;
      if (!f && this.job.hiddenLayers.OUTSIDE_CUT && this.step !== 'trace') continue;
      const isActive = k === this.active && editing;
      const closed = !f || f.closed !== false;
      const pts = c.map(S);
      const raw = this.step === 'trace' ? 'rgba(66,165,245,' : null;
      ctx.strokeStyle = raw ? raw + (isActive ? '.95)' : '.5)') : colorOf(f);
      ctx.globalAlpha = this.step === 'clean' || this.step === 'export' || this.step === 'result' ? 0.45 : 1;
      ctx.lineWidth = isActive ? 4 : editing ? 2.5 : 1.25;
      if (f && f.cut === 'skip') ctx.setLineDash([8, 6]);
      ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
      if (closed && !(this.drawing && isActive)) ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      if (isActive && (this.step === 'trace' || this.tool !== 'select')) {
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
        if (this.drawing && pts.length && closed) { ctx.strokeStyle = '#ffd60a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(pts[0][0], pts[0][1], 14, 0, 7); ctx.stroke(); }
      }
      // number tags so the list and the picture match
      if (f && (this.step === 'details' || this.step === 'result') && !inLoupe && pts.length) {
        // tag at the shape's top-left corner, so nested shapes' tags don't sit on top of each other
        const top = pts.reduce((m, p) => (p[0] + p[1] < m[0] + m[1] ? p : m), pts[0]);
        const label = String(k + 1);
        ctx.font = 'bold 13px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = colorOf(f); ctx.beginPath(); ctx.arc(top[0], top[1] - 2, 11, 0, 7); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.fillText(label, top[0], top[1] - 2);
      }
    }
    // cleaned shape: lines and arcs, colored by cut type
    if (this.shape && (this.step === 'clean' || this.step === 'export' || this.step === 'trace' || this.step === 'result')) {
      ctx.lineJoin = 'round';
      const loops = [{ segs: this.shape.outer, closed: true, cut: 'outside' }, ...(this.shape.parts || [])];
      for (const loop of loops) {
        if (this.step === 'trace' && loop.cut !== 'outside') continue;
        const f = loop.cut === 'outside' ? { cut: 'outside' } : loop;
        if (this.isHidden(f)) continue;
        ctx.strokeStyle = CUT_TYPES[loop.cut]?.color || '#ff6b00';
        ctx.lineWidth = this.step === 'trace' ? 2.5 : 3.5;
        if (loop.cut === 'skip') ctx.setLineDash([8, 6]);
        ctx.beginPath();
        loop.segs.forEach((sg, i) => segPoints(sg, 0.05).forEach((q, j) => { const p = S({ x: q[0], y: q[1] }); if (i === 0 && j === 0) ctx.moveTo(...p); else ctx.lineTo(...p); }));
        if (loop.closed) ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (this.step === 'clean' && !inLoupe) {
        // vertices where lines/arcs meet
        ctx.fillStyle = '#fff';
        for (const loop of loops) for (const sg of loop.segs) { const p = S({ x: sg.a[0], y: sg.a[1] }); ctx.beginPath(); ctx.arc(p[0], p[1], 3.5, 0, 7); ctx.fill(); }
      }
    }
    if (this.seed && this.step === 'trace') {
      const p = st.toScr(this.seed);
      ctx.strokeStyle = '#00e676'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(p[0], p[1], 10, 0, 7); ctx.stroke();
    }
  }

  stepTrace() {
    this.active = -1;
    if (!['move', 'add', 'delete', 'corner', 'seed'].includes(this.tool)) this.tool = 'move';
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
      const chips = el('p', { class: 'small muted' });
      const tb = {};
      [['move', '✋ Move'], ['add', '➕ Add'], ['delete', '🗑 Delete'], ['corner', '◆ Corner']].forEach(([id, label]) => {
        tb[id] = el('button', {}, label);
        tb[id].onclick = () => { this.tool = id; this.drawing = false; this.refreshTools(); };
        tools.appendChild(tb[id]);
      });
      const undo = el('button', {}, '↶ Undo');
      const closeBtn = el('button', { class: 'go' }, 'Close shape');
      const next = el('button', { class: 'go' }, 'Next: details →');
      undo.onclick = () => this.popUndo();
      closeBtn.onclick = () => this.finishDrawing();
      next.onclick = () => this.go('details');
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
        chips.textContent = `Outline: ${this.job.contours.outer.length} points. Panels, cutouts and grooves come next, in Details.`;
        next.disabled = this.job.contours.outer.length < 3;
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
          // threshold modes also report holes; they become cutouts if no details were set up yet
          const holes = res.holes.map(conv).filter((h) => h.length >= 3);
          if (holes.length && !this.job.features.length) this.job.features = holes.map((pts) => ({ pts, closed: true, cut: 'inside', src: 'auto' }));
          freeDetailEdges(this.found); this.found = null;
          this.active = -1;
          this.drawing = false;
          this.refreshTools();
          this.changed();
          toast(`Found the outline${holes.length ? ` and ${holes.length} cutout(s)` : ''}. Check it, then go on to Details.`);
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

  // ---------------------------------------------------------------- step 5: interior details
  stepDetails() {
    if (this.active >= this.job.features.length) this.active = -1;
    if (!['select', 'region', 'move', 'add', 'delete', 'corner'].includes(this.tool)) this.tool = 'select';
    this.drawing = false;
    this.buildCanvasEditor((panel) => {
      const d = this.settings.denom;
      const findBtn = el('button', { class: 'primary' }, '🔍 Find details');
      const askBtn = el('button', {}, '🤖 Suggest details');
      const sens = el('input', { type: 'range', min: 1, max: 10, step: 1, value: this.job.detailSens, 'aria-label': 'Sensitivity' });
      const sensVal = el('span', { class: 'muted' });
      const minSz = el('input', { type: 'range', min: 1, max: 16, step: 1, value: Math.round(this.job.minFeature * 4), 'aria-label': 'Minimum feature size' });
      const minVal = el('span', { class: 'muted' });
      // cut type buttons, color-coded like the drawing
      const cutGrid = el('div', { class: 'cut-grid' });
      const cutBtns = {};
      for (const [id, t] of Object.entries(CUT_TYPES)) {
        if (id === 'outside') continue;
        const b = el('button', { class: 'cut-btn', style: `--c:${t.color}` }, t.label.toUpperCase());
        b.onclick = () => this.setCut(id);
        cutBtns[id] = b;
        cutGrid.appendChild(b);
      }
      const depth = el('input', { inputmode: 'text', placeholder: 'e.g. 1/4', 'aria-label': 'Depth' });
      const depthRow = el('div', {}, el('label', {}, 'Depth (inches)'), depth);
      const bit = el('select', { 'aria-label': 'Bit' });
      const bitRow = el('div', {}, el('label', {}, 'Router bit'), bit);
      const info = el('div', { class: 'sel-info' });
      depth.onchange = () => {
        const f = this.job.features[this.active];
        const v = parseInches(depth.value);
        if (!f) return;
        if (!(v > 0 && v < 3)) { toast('Can’t read that depth. Try 1/4 or 0.25'); depth.value = formatInches(f.depth, 64); return; }
        this.pushUndo(); f.depth = v; this.changed(); this.refreshTools();
      };
      bit.onchange = () => { const f = this.job.features[this.active]; if (f) { this.pushUndo(); f.bit = bit.value; this.changed(); this.refreshTools(); } };
      // tools
      const tb = {};
      const tools = el('div', { class: 'toolbar' });
      [['select', '👆 Pick'], ['region', '➕ Tap area'], ['shape', '✏️ Draw shape'], ['line', '〰 Draw line']].forEach(([id, label]) => {
        tb[id] = el('button', {}, label);
        tools.appendChild(tb[id]);
      });
      const ptools = el('div', { class: 'toolbar' });
      [['move', '✋ Move pts'], ['add', '➕ Add pt'], ['delete', '🗑 Delete pt'], ['corner', '◆ Corner']].forEach(([id, label]) => {
        tb[id] = el('button', {}, label);
        ptools.appendChild(tb[id]);
      });
      for (const id of ['select', 'region', 'move', 'add', 'delete', 'corner']) tb[id].onclick = () => { this.tool = id; this.drawing = false; this.refreshTools(); this.stage.render(); };
      const startDraw = (closed) => {
        this.pushUndo();
        this.job.features.push({ pts: [], closed, cut: closed ? 'pocket' : 'groove', depth: closed ? DEFAULT_DEPTH.pocket : DEFAULT_DEPTH.groove, bit: closed ? undefined : DEFAULT_BIT.groove, src: 'hand' });
        this.active = this.job.features.length - 1;
        this.drawing = true;
        this.tool = 'move';
        this.refreshTools();
      };
      tb.shape.onclick = () => startDraw(true);
      tb.line.onclick = () => startDraw(false);
      const doneBtn = el('button', { class: 'go' }, '✓ Done drawing');
      doneBtn.onclick = () => this.finishDrawing();
      const removeBtn = el('button', { class: 'danger' }, '🗑 Remove shape');
      removeBtn.onclick = () => {
        if (this.active < 0) return;
        this.pushUndo();
        this.job.features.splice(this.active, 1);
        this.active = -1; this.drawing = false;
        this.refreshTools(); this.changed();
      };
      const undo = el('button', {}, '↶ Undo');
      undo.onclick = () => this.popUndo();
      const next = el('button', { class: 'go' }, 'Next: clean up →');
      next.onclick = () => { if (this.drawing) this.finishDrawing(); this.go('clean'); };
      const list = el('div', { class: 'feat-list' });
      const legend = el('div');
      const claudeNote = el('div');

      const run = async (btn, label, fn) => {
        btn.disabled = true;
        const old = btn.textContent;
        btn.textContent = label;
        try { await fn(); } catch (e) { toast(e.message || String(e), 5000); } finally { btn.disabled = false; btn.textContent = old; }
      };
      findBtn.onclick = () => run(findBtn, 'Looking…', async () => {
        this.pushUndo();
        const n = await this.findDetails(true);
        this.active = -1;
        this.refreshTools(); this.changed();
        toast(n ? `Found ${n} detail${n > 1 ? 's' : ''}. Tap one to check its cut type.` : 'Nothing found. Raise the sensitivity, lower the minimum size, or draw it.', 4000);
      });
      askBtn.onclick = () => run(askBtn, 'Asking Claude…', async () => {
        const res = await this.suggestWithClaude();
        claudeNote.className = 'note';
        claudeNote.textContent = `Claude: ${res.summary}` + (res.warnings?.length ? ` · ${res.warnings.join(' · ')}` : '') + ' Check each shape before you export.';
        this.refreshTools(); this.changed();
      });
      sens.oninput = () => { this.job.detailSens = +sens.value; this.refreshTools(); this.save(); };
      minSz.oninput = () => { this.job.minFeature = +minSz.value / 4; this.refreshTools(); this.save(); };

      const hints = {
        select: 'Tap a shape to pick it, then choose its cut type. Pinch to zoom.',
        region: 'Tap inside an area the edges surround (a panel, an arch) to add it as a shape.',
        move: 'Drag the picked shape’s points.',
        add: 'Tap on the picked shape’s line to add a point.',
        delete: 'Tap a point of the picked shape to delete it.',
        corner: 'Tap a point: sharp corner → smooth → automatic.',
      };
      this.refreshTools = () => {
        const f = this.job.features[this.active];
        sensVal.textContent = ` ${this.job.detailSens} of 10`;
        minVal.textContent = ` ${formatInches(this.job.minFeature, 16)}`;
        Object.entries(tb).forEach(([id, b]) => b.classList.toggle('on', (id === this.tool && !this.drawing) || (this.drawing && f && id === (f.closed === false ? 'line' : 'shape'))));
        for (const id of ['move', 'add', 'delete', 'corner']) tb[id].disabled = !f;
        removeBtn.disabled = !f;
        doneBtn.style.display = this.drawing ? '' : 'none';
        this.hintEl.textContent = this.drawing
          ? (f?.closed === false ? 'Tap along the line, one point at a time, then ✓ Done drawing.' : 'Tap around the shape, one point at a time. Tap the first point (or ✓ Done) to close it.')
          : !f && ['move', 'add', 'delete', 'corner'].includes(this.tool) ? 'Tap a shape (its line or inside it) to pick it.' : hints[this.tool];
        for (const [id, b] of Object.entries(cutBtns)) { b.disabled = !f; b.classList.toggle('picked', !!f && f.cut === id); }
        const t = f && CUT_TYPES[f.cut];
        depthRow.style.display = t?.depth ? '' : 'none';
        bitRow.style.display = t?.bit ? '' : 'none';
        if (f && t?.depth) depth.value = formatInches(f.depth ?? DEFAULT_DEPTH[f.cut], 64);
        if (f && t?.bit) {
          const bits = bitsFor(f.cut);
          bit.innerHTML = '';
          bits.forEach((b) => bit.appendChild(el('option', { value: b.id }, b.label)));
          bit.value = bits.some((b) => b.id === f.bit) ? f.bit : bits[0].id;
        }
        info.innerHTML = '';
        if (f) {
          const bb = ptsBBox(f.pts);
          info.append(
            el('div', { class: 'sel-title', style: `--c:${t.color}` }, `#${this.active + 1} · ${t.label}`, el('span', { class: 'muted' }, ` · ${f.closed === false ? 'line' : 'shape'} ${formatInches(bb.w, d)} × ${formatInches(bb.h, d)}`)),
            f.why ? el('div', { class: 'small muted' }, (f.src === 'claude' ? '🤖 ' : f.src === 'auto' ? '🔍 ' : '') + f.why) : '',
            f.cut === 'profile' ? el('div', { class: 'small muted' }, 'A photo can’t show how deep a profile goes: the bit sets it. The layer name carries the bit.') : '',
            el('div', { class: 'small' }, 'DXF layer: ', el('b', {}, layerFor(f) || 'not exported')),
          );
        } else info.append(el('div', { class: 'small muted' }, this.job.features.length ? 'Tap a shape (or a number in the list) to pick it.' : 'Tap 🔍 Find details, or draw shapes by hand.'));
        // list of shapes
        list.innerHTML = '';
        this.job.features.forEach((g, i) => {
          const tt = CUT_TYPES[g.cut] || CUT_TYPES.skip;
          const bb = ptsBBox(g.pts);
          const row = el('button', { class: 'feat-row' + (i === this.active ? ' on' : ''), style: `--c:${tt.color}` },
            el('span', { class: 'dot' }, String(i + 1)),
            el('span', { class: 'grow' }, `${tt.label}${tt.depth ? ' ' + formatInches(g.depth ?? DEFAULT_DEPTH[g.cut], 64) : ''}`, el('span', { class: 'muted' }, ` · ${formatInches(bb.w, 8)} × ${formatInches(bb.h, 8)}`)),
            g.src === 'claude' ? el('span', { class: 'tag' }, 'Claude') : '');
          row.onclick = () => { this.active = i; this.drawing = false; if (!['select', 'move', 'add', 'delete', 'corner'].includes(this.tool)) this.tool = 'select'; this.refreshTools(); this.stage.render(); };
          list.appendChild(row);
        });
        legend.replaceChildren(this.legendEl());
      };
      panel.append(
        el('div', { class: 'grid2' }, findBtn, askBtn),
        el('label', {}, 'Edge sensitivity', sensVal), sens,
        el('label', {}, 'Ignore details smaller than', minVal), minSz,
        claudeNote,
        tools,
        el('div', { class: 'row', style: 'margin-top:6px' }, doneBtn),
        el('h3', {}, 'Picked shape'), info,
        el('div', { class: 'small', style: 'font-weight:700;margin-top:6px' }, 'Cut type'), cutGrid, depthRow, bitRow,
        ptools,
        el('div', { class: 'row', style: 'margin-top:8px' }, removeBtn, undo),
        el('h3', {}, 'All shapes'), list,
        el('h3', {}, 'Layers'), legend,
        el('div', { class: 'row', style: 'margin-top:12px' }, next),
      );
      this.refreshTools();
    }, '');
  }

  setCut(cut) {
    const f = this.job.features[this.active];
    if (!f) return;
    this.pushUndo();
    f.cut = cut;
    if (CUT_TYPES[cut].depth && !(f.depth > 0)) f.depth = DEFAULT_DEPTH[cut];
    if (CUT_TYPES[cut].bit && !bitsFor(cut).some((b) => b.id === f.bit)) f.bit = DEFAULT_BIT[cut];
    this.changed();
    this.refreshTools && this.refreshTools();
  }

  // Runs detection inside the outline. apply: replace earlier auto-found shapes with the new ones
  // (shapes you drew, tapped or got from Claude stay). Returns how many were found.
  async findDetails(apply = true) {
    const ppi = this.straight.ppi;
    const outerPx = this.job.contours.outer.map((q) => this.px(q));
    freeDetailEdges(this.found);
    this.found = await detectDetails(this.straight.canvas, outerPx, ppi, { sensitivity: this.job.detailSens, minSize: this.job.minFeature });
    if (!apply) return this.found.shapes.length;
    const step = 0.08 * ppi; // a point about every 1/12"
    const auto = this.found.shapes.map((sh) => ({
      pts: (sh.closed ? resampleOutline(sh.pts, step) : resampleLine(sh.pts, step)).map((r) => this.inch(r)),
      closed: sh.closed, cut: sh.guess.cut, why: sh.guess.why, src: 'auto',
      depth: DEFAULT_DEPTH[sh.guess.cut], bit: DEFAULT_BIT[sh.guess.cut],
    }));
    this.job.features = [...auto, ...this.job.features.filter((f) => f.src !== 'auto')];
    return auto.length;
  }

  // Sends the straightened part, with the shapes drawn and numbered on it, to Claude; applies its answer.
  async suggestWithClaude() {
    if (!this.settings.apiKey) throw new Error('Add your Claude API key in Settings first (⚙ top right).');
    const bb = ptsBBox(this.job.contours.outer);
    const m = 0.4;
    const x0 = bb.minX - m, y0 = bb.minY - m, wIn = bb.w + 2 * m, hIn = bb.h + 2 * m;
    const k = Math.min(1568 / Math.max(wIn, hIn), this.straight.ppi);
    const c = document.createElement('canvas');
    c.width = Math.round(wIn * k); c.height = Math.round(hIn * k);
    const ctx = c.getContext('2d');
    const p0 = this.px({ x: x0, y: y0 });
    ctx.drawImage(this.straight.canvas, p0[0], p0[1], wIn * this.straight.ppi, hIn * this.straight.ppi, 0, 0, c.width, c.height);
    const T = (q) => [(q.x - x0) * k, (q.y - y0) * k];
    const shapes = [];
    this.job.features.forEach((f, i) => {
      if (f.pts.length < 2) return;
      const col = CUT_TYPES[f.cut]?.color || '#888';
      ctx.strokeStyle = col; ctx.lineWidth = 3;
      ctx.beginPath(); f.pts.forEach((q, j) => (j ? ctx.lineTo(...T(q)) : ctx.moveTo(...T(q)))); if (f.closed !== false) ctx.closePath(); ctx.stroke();
      const top = f.pts.reduce((a, q) => (q.y < a.y ? q : a), f.pts[0]);
      const [tx, ty] = T(top);
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(tx, ty, 15, 0, 7); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 18px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(i + 1), tx, ty);
      const fb = ptsBBox(f.pts);
      shapes.push({ id: i + 1, closed: f.closed !== false, cut: f.cut, x: fb.minX - x0, y: fb.minY - y0, w: fb.w, h: fb.h });
    });
    const b64 = c.toDataURL('image/jpeg', 0.88).split(',')[1];
    const res = await suggestDetails({ apiKey: this.settings.apiKey, imageBase64: b64, widthIn: wIn, heightIn: hIn, shapes });
    this.pushUndo();
    const bitOk = (cut, b) => bitsFor(cut).some((x) => x.id === b);
    for (const a of res.shapes || []) {
      const f = this.job.features[a.id - 1];
      if (!f || !CUT_TYPES[a.cut]) continue;
      f.cut = a.cut;
      if (CUT_TYPES[a.cut].depth) f.depth = a.depth_in > 0 && a.depth_in < 3 ? a.depth_in : f.depth ?? DEFAULT_DEPTH[a.cut];
      if (CUT_TYPES[a.cut].bit) f.bit = bitOk(a.cut, a.bit) ? a.bit : f.bit ?? DEFAULT_BIT[a.cut];
      f.why = `${a.description} (${a.confidence} confidence)`;
      f.src = f.src === 'auto' ? 'claude' : f.src;
    }
    for (const a of res.missing || []) {
      const pts = (a.points_in || []).filter((q) => isFinite(q.x) && isFinite(q.y)).map((q) => ({ x: q.x + x0, y: q.y + y0 }));
      if (pts.length < (a.closed ? 3 : 2) || !CUT_TYPES[a.cut]) continue;
      this.job.features.push({
        pts, closed: a.closed, cut: a.cut, src: 'claude', why: `${a.description}. Drawn by Claude from the photo: rough, check the points.`,
        depth: CUT_TYPES[a.cut].depth ? (a.depth_in > 0 && a.depth_in < 3 ? a.depth_in : DEFAULT_DEPTH[a.cut]) : undefined,
        bit: CUT_TYPES[a.cut].bit ? (bitOk(a.cut, a.bit) ? a.bit : DEFAULT_BIT[a.cut]) : undefined,
      });
    }
    return res;
  }

  // Layer list with a show/hide toggle for each (what's on screen only; export is unaffected).
  legendEl() {
    const layers = new Map();
    layers.set('OUTSIDE_CUT', { color: CUT_TYPES.outside.color, label: 'Outside cut', n: 1 });
    for (const f of this.job.features) {
      const name = layerFor(f) || 'NOT_CUT';
      const t = CUT_TYPES[f.cut] || CUT_TYPES.skip;
      const cur = layers.get(name) || { color: t.color, label: t.label, n: 0 };
      cur.n++;
      layers.set(name, cur);
    }
    const box = el('div', { class: 'legend' });
    for (const [name, l] of layers) {
      const hidden = !!this.job.hiddenLayers[name];
      const b = el('button', { class: 'legend-item' + (hidden ? ' off' : ''), style: `--c:${l.color}`, 'aria-pressed': String(!hidden) },
        el('span', { class: 'swatch' }), el('span', { class: 'grow' }, name === 'NOT_CUT' ? 'Not cut (not exported)' : name, el('span', { class: 'muted' }, ` · ${l.n}`)), el('span', {}, hidden ? '🙈' : '👁'));
      b.onclick = () => {
        if (hidden) delete this.job.hiddenLayers[name]; else this.job.hiddenLayers[name] = true;
        this.save();
        this.refreshTools ? this.refreshTools() : b.replaceWith(this.legendEl());
        this.stage && this.stage.render();
        this.onLegend && this.onLegend();
      };
      box.appendChild(b);
    }
    return box;
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
          : 'Bold = the clean shapes (lines and true arcs), faint = your trace. Turn on Mirror for symmetric parts; it mirrors the details too.';
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
          const all = [this.shape.outer, ...this.shape.parts.filter((q) => q.cut !== 'skip').map((q) => q.segs)].flat();
          const nl = all.filter((s) => s.type === 'line').length, na = all.length - nl;
          this.hintEl.textContent = `${nl} lines + ${na} arcs. ` + (m.on ? 'Drag the pink ⇔ handle to move the centerline.' : 'Bold = clean shapes, faint = your trace.');
        }
      };
      const legend = el('div');
      this.refreshTools = () => legend.replaceChildren(this.legendEl());
      this.refreshTools();
      panel.append(
        el('div', { class: 'grid2' }, mirrorBtn, keepBtn),
        center,
        el('label', {}, 'Smoothing', smoothVal), smooth,
        el('label', { class: 'check' }, snap, 'Snap near-straight edges to level / plumb'),
        warn,
        el('div', { class: 'row' }, undo, next),
        el('h3', {}, 'Layers'), legend,
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
      page.append(el('div', { class: 'bad-box' }, 'No clean shape yet. Go back to Outline.'));
      this.view.appendChild(page);
      return;
    }
    const bb = shapeBBox({ outer: this.shape.outer, holes: [] });
    const d = s.denom;
    // all layers over the straightened photo, with a legend to show/hide each
    const wrap = el('div', { class: 'stage-wrap export-stage' });
    const legend = el('div');
    const refreshLegend = () => legend.replaceChildren(this.legendEl());
    this.onLegend = refreshLegend;
    const prev = renderShapePNG(this.shape, { name: this.job.name, denom: d, width: 900 });
    const name = el('input', { value: this.job.fileName || safeFileName(this.job.name || 'shape') });
    const ver = el('select', {}, el('option', { value: 'R2000' }, 'DXF 2000 (units stored as inches)'), el('option', { value: 'R12' }, 'DXF R12 (oldest, most compatible)'));
    ver.value = this.job.dxfVersion || s.dxfVersion;
    const only = el('input', { type: 'checkbox' });
    only.checked = !!this.job.outlineOnly;
    const result = el('div');
    const dl = el('button', { class: 'go' }, '⬇ Download DXF');
    const share = el('button', {}, '📤 Share DXF');
    const png = el('button', {}, '🖼 Save PNG with dimensions');
    const verNote = el('p', { class: 'small muted' });
    const build = () => {
      this.job.fileName = name.value; this.job.dxfVersion = ver.value; this.job.outlineOnly = only.checked; this.save();
      const text = writeDXF(this.shape, { version: ver.value, outlineOnly: only.checked, outlineLayer: s.layerOuter });
      const chk = checkDXF(text);
      showCheck(result, chk, d);
      verNote.textContent = ver.value === 'R12' && !only.checked ? 'R12 layer names can’t contain dots, so depths are written like POCKET_0p25.' : '';
      const base = safeFileName(name.value || 'shape');
      return { text, chk, file: (only.checked && !/outline/i.test(base) ? base + '-outline' : base) + '.dxf' };
    };
    build();
    name.oninput = ver.onchange = only.onchange = () => build();
    dl.onclick = () => {
      const { text, chk, file } = build();
      if (!chk.ok && !confirm('The self-check found a problem (see below). Download anyway?')) return;
      downloadBlob(new Blob([text], { type: 'application/dxf' }), file);
      this.markParentDone(file);
    };
    share.onclick = async () => {
      const { text, file } = build();
      const ok = await shareFile(new File([text], file, { type: 'application/dxf' }), 'DXF for Mozaik');
      if (!ok) downloadBlob(new Blob([text], { type: 'application/dxf' }), file);
      this.markParentDone(file);
    };
    // tracing a part from a build sheet: once the DXF is saved, the way back is the next step
    let doneBox = '';
    if (this.job.parent) {
      const backB = el('button', { class: 'go' }, `← Done, back to ${this.job.parent.jobName}`);
      backB.onclick = () => this.backToParent();
      doneBox = el('div', { class: 'ok-box' }, el('p', {}, `✓ DXF saved. ${this.job.parent.label} is ticked off on the build sheet.`), backB);
      doneBox.style.display = this.job.parentDone ? '' : 'none';
      this.doneBox = doneBox;
    }
    png.onclick = async () => {
      const c = renderShapePNG(this.shape, { name: this.job.name, denom: d, width: 1800, footer: true });
      downloadBlob(await canvasToBlob(c, 'image/png'), safeFileName(name.value || 'shape') + '.png');
    };
    const hasProfile = (this.shape.parts || []).some((q) => q.cut === 'profile');
    page.append(
      el('h2', {}, `${formatInches(bb.w, d)} wide × ${formatInches(bb.h, d)} tall`),
      el('p', { class: 'small muted' }, 'All layers over your photo. Tap a layer below to hide or show it (screen only; the file always has every layer).'),
      wrap,
      legend,
      el('h3', {}, 'With dimensions'),
      el('img', { class: 'preview-img', src: prev.toDataURL('image/png'), alt: 'Shape preview' }),
      el('div', { class: 'note' }, ACCURACY_NOTE + (this.job.aspectGuess ? ' Only one side of the reference rectangle was entered, so the other direction is a photo estimate.' : '') +
        ' Depths are what you entered: a photo can’t show depth.' + (hasProfile ? ' Profile depth comes from the bit you pick.' : '')),
      el('label', {}, 'File name'), name,
      el('label', {}, 'DXF format'), ver, verNote,
      el('label', { class: 'check' }, only, 'Outer outline only (for Mozaik’s Part Editor)'),
      el('div', { class: 'stack', style: 'margin-top:12px' }, dl, share, png),
      doneBox,
      el('h3', {}, 'Self-check (the file is re-opened and tested)'), result,
      el('h3', {}, 'In Mozaik'),
      el('p', { class: 'small' }, `Part Editor → DXF In → pick the outline-only file (outline on layer “${s.layerOuter}”, lower-left corner at 0,0). ` +
        'The full file has one layer per cut: OUTSIDE_CUT, INSIDE_CUT, POCKET_<depth>, VGROOVE_<angle>_<depth>, PROFILE_EDGE_<bit>. Map each layer to a toolpath in your CAM.'),
    );
    this.view.appendChild(page);
    refreshLegend();
    this.stage = new Stage(wrap, { draw: (ctx, st, inLoupe) => this.drawOverlay(ctx, st, inLoupe) });
    this.stage.setImage(this.straight.canvas);
    const pts = this.job.contours.outer.map((q) => this.px(q));
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    this.stage.fit({ x: Math.min(...xs) - 20, y: Math.min(...ys) - 20, w: Math.max(...xs) - Math.min(...xs) + 40, h: Math.max(...ys) - Math.min(...ys) + 40 });
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
  const names = Object.keys(chk.layers);
  const mustClose = names.filter((n) => !openAllowed(n));
  const closedOk = mustClose.every((n) => chk.layers[n].closed === chk.layers[n].shapes);
  const openLines = names.filter(openAllowed).reduce((t, n) => t + chk.layers[n].shapes - chk.layers[n].closed, 0);
  box.append(el('ul', { class: 'checks' },
    li(closedOk, `${chk.loops} shape(s); every cut-through and pocket shape is closed` + (openLines ? ` (plus ${openLines} open groove/profile line${openLines > 1 ? 's' : ''}, which is fine)` : '')),
    li(chk.kinds.every((k) => k === 'LINE' || k === 'ARC'), `Only lines and arcs (${chk.lines} lines, ${chk.arcs} arcs, no splines)`),
    li(chk.version === 'AC1009' || chk.insunits === 1, chk.version === 'AC1015' ? 'Units: inches ($INSUNITS = 1)' : 'R12 file: no units field, all values are inches'),
    li(!chk.problems.some((p) => p.includes('Lower-left')), 'Lower-left corner at 0,0'),
    li(true, `Size in file: ${formatInches(chk.width, denom)} × ${formatInches(chk.height, denom)}`),
  ));
  const t = el('table', { class: 'layer-table' }, el('tr', {}, el('th', {}, 'Layer'), el('th', {}, 'Shapes'), el('th', {}, 'Lines'), el('th', {}, 'Arcs')));
  for (const n of names) t.append(el('tr', {}, el('td', {}, n), el('td', {}, `${chk.layers[n].shapes}${chk.layers[n].closed < chk.layers[n].shapes ? ` (${chk.layers[n].shapes - chk.layers[n].closed} open)` : ''}`), el('td', {}, String(chk.layers[n].lines)), el('td', {}, String(chk.layers[n].arcs))));
  box.append(t);
  if (chk.problems.length) box.append(el('p', {}, chk.problems.join(' ')));
}

const sub2 = (a, b) => [a[0] - b[0], a[1] - b[1]];
function inPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt[1]) !== (b.y > pt[1]) && pt[0] < ((b.x - a.x) * (pt[1] - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function ptsBBox(pts) {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  if (!pts.length) return { minX: 0, minY: 0, w: 0, h: 0 };
  const minX = Math.min(...xs), minY = Math.min(...ys);
  return { minX, minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}
function polyArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p.x * q.y - q.x * p.y; }
  return Math.abs(a) / 2;
}
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
  const nLayers = new Set((shape.parts || []).filter((p) => p.cut !== 'skip').map((p) => layerFor(p))).size;
  const legendH = nLayers ? (nLayers + 1) * Math.round(width / 40) + 10 : 0;
  const W = width, H = Math.round(bb.h * k + 2 * margin + (footer ? 70 : 0) + legendH);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  const ox = (W - bb.w * k) / 2;
  const T = (p) => [ox + p[0] * k, margin + (bb.h - p[1]) * k];
  const trace = (loop, closed = true) => {
    loop.forEach((s, i) => segPoints(s, 0.02).forEach((q, j) => { const p = T(q); if (i === 0 && j === 0) ctx.moveTo(...p); else ctx.lineTo(...p); }));
    if (closed) ctx.closePath();
  };
  ctx.beginPath();
  for (const loop of [cad.outer, ...cad.holes]) trace(loop);
  ctx.fillStyle = '#ffe8d6'; ctx.fill('evenodd');
  ctx.strokeStyle = '#000'; ctx.lineWidth = Math.max(2, width / 500);
  ctx.beginPath(); trace(cad.outer); ctx.stroke();
  // interior shapes in their layer colors
  const used = new Map();
  for (const p of cad.parts || []) {
    if (p.cut === 'skip') continue;
    const t = CUT_TYPES[p.cut];
    ctx.strokeStyle = t.color; ctx.lineWidth = Math.max(2, width / 450);
    ctx.beginPath(); trace(p.segs, p.closed); ctx.stroke();
    used.set(layerFor(p), t.color);
  }
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
  if (used.size) {
    const lh = Math.round(width / 40);
    let y = margin + bb.h * k + margin * 0.95;
    ctx.font = `${Math.round(lh * 0.8)}px system-ui, sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (const [n, col] of [['OUTSIDE_CUT', '#000'], ...used]) {
      ctx.fillStyle = col; ctx.fillRect(20, y - lh * 0.3, lh * 1.2, lh * 0.6);
      ctx.fillStyle = '#111'; ctx.fillText(n, 30 + lh * 1.2, y);
      y += lh;
    }
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
