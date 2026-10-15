// A canvas that shows an image you can pinch-zoom and pan, with tap and drag callbacks in image coordinates.
// One finger: the active tool (if it claims the touch) or pan. Two fingers: zoom + pan.
// While dragging a point, a magnifier shows what's under your finger.

export class Stage {
  constructor(wrap, { onTap, onPress, onDrag, onRelease, draw } = {}) {
    this.wrap = wrap;
    this.canvas = document.createElement('canvas');
    wrap.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.cb = { onTap, onPress, onDrag, onRelease, draw };
    this.image = null;
    this.view = { s: 1, tx: 0, ty: 0 };
    this.pointers = new Map();
    this.mode = null; // 'tool' | 'pan' | 'pinch'
    this.loupe = null;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(wrap);
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.down(e));
    c.addEventListener('pointermove', (e) => this.move(e));
    c.addEventListener('pointerup', (e) => this.up(e));
    c.addEventListener('pointercancel', (e) => this.up(e, true));
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = this.local(e);
      this.zoomAt(p, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });
    this.resize();
    window.__stage = this; // handy for automated tests
  }

  destroy() { this.ro.disconnect(); this.canvas.remove(); }

  setImage(img, fit = true) {
    this.image = img;
    if (fit) this.fit();
    this.render();
  }

  get imgW() { return this.image ? this.image.width || this.image.naturalWidth : 1000; }
  get imgH() { return this.image ? this.image.height || this.image.naturalHeight : 1000; }

  resize() {
    const r = this.wrap.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * this.dpr)), h = Math.max(1, Math.round(r.height * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      const first = !this.cssW;
      this.canvas.width = w; this.canvas.height = h;
      this.cssW = r.width; this.cssH = r.height;
      // keep the last framing while the user hasn't panned or zoomed (the panel below can change the stage height)
      if (first || this.autoFit) this.fit();
      else if (this.lastFit !== undefined && !this.moved) this.fit(this.lastFit);
    }
    this.render();
  }

  fit(box) {
    const W = this.cssW || 1, H = this.cssH || 1;
    this.lastFit = box; this.moved = false;
    const b = box || { x: 0, y: 0, w: this.imgW, h: this.imgH };
    const s = Math.min(W / b.w, H / b.h) * 0.94;
    this.view = { s, tx: (W - b.w * s) / 2 - b.x * s, ty: (H - b.h * s) / 2 - b.y * s };
    this.render();
  }

  // screen (css px) <-> image px
  toImg(p) { return [(p[0] - this.view.tx) / this.view.s, (p[1] - this.view.ty) / this.view.s]; }
  toScr(p) { return [p[0] * this.view.s + this.view.tx, p[1] * this.view.s + this.view.ty]; }
  local(e) { const r = this.canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

  zoomAt(p, k) {
    this.moved = true;
    const s = Math.max(0.02, Math.min(this.view.s * k, 60));
    const q = this.toImg(p);
    this.view.s = s;
    this.view.tx = p[0] - q[0] * s;
    this.view.ty = p[1] - q[1] * s;
    this.render();
  }

  down(e) {
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 1) {
      this.start = { p, t: performance.now(), moved: false };
      const claimed = this.cb.onPress ? this.cb.onPress(this.toImg(p), this) : false;
      this.mode = claimed ? 'tool' : 'pan';
      if (claimed) this.loupe = p;
    } else if (this.pointers.size === 2) {
      if (this.mode === 'tool' && this.cb.onRelease) this.cb.onRelease(null, this, true);
      this.mode = 'pinch';
      this.loupe = null;
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), c: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
    }
    this.render();
  }

  move(e) {
    if (!this.pointers.has(e.pointerId)) return;
    const prev = this.pointers.get(e.pointerId);
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (this.start && Math.hypot(p[0] - this.start.p[0], p[1] - this.start.p[1]) > 8) this.start.moved = true;
    if (this.mode === 'tool') {
      this.loupe = p;
      if (this.cb.onDrag) this.cb.onDrag(this.toImg(p), this);
    } else if (this.mode === 'pan' && this.start?.moved) {
      this.moved = true;
      this.view.tx += p[0] - prev[0];
      this.view.ty += p[1] - prev[1];
    } else if (this.mode === 'pinch' && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      this.view.tx += c[0] - this.pinch.c[0];
      this.view.ty += c[1] - this.pinch.c[1];
      this.zoomAt(c, d / (this.pinch.d || d));
      this.pinch = { d, c };
    }
    this.render();
  }

  up(e, cancelled = false) {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this.local(e);
    this.pointers.delete(e.pointerId);
    if (this.mode === 'tool') {
      if (this.cb.onRelease) this.cb.onRelease(this.toImg(p), this, cancelled);
    }
    if (this.pointers.size === 0) {
      const quick = this.start && !this.start.moved && performance.now() - this.start.t < 450;
      if (quick && !cancelled && this.mode !== 'pinch' && this.cb.onTap) this.cb.onTap(this.toImg(p), this, this.mode === 'tool');
      this.mode = null;
      this.loupe = null;
      this.start = null;
    }
    this.render();
  }

  render() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      this.paint();
    });
  }

  paint() {
    const { ctx, canvas, dpr } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#2b2f36';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr * this.view.s, 0, 0, dpr * this.view.s, dpr * this.view.tx, dpr * this.view.ty);
    if (this.image) {
      ctx.imageSmoothingEnabled = this.view.s < 3;
      ctx.drawImage(this.image, 0, 0);
    }
    // overlays draw in screen space using toScr, so lines and handles keep a constant size
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.cb.draw) this.cb.draw(ctx, this);
    if (this.loupe && this.image) this.paintLoupe();
  }

  paintLoupe() {
    const { ctx } = this;
    const R = 62, zoom = 3;
    const p = this.loupe;
    // keep the magnifier above the finger, or below it near the top edge
    const cx = Math.min(Math.max(p[0], R + 4), this.cssW - R - 4);
    const cy = p[1] - 120 > R + 4 ? p[1] - 120 : p[1] + 120;
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = '#2b2f36'; ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
    // map: screen point p shows at loupe center, zoomed
    ctx.translate(cx, cy); ctx.scale(zoom, zoom); ctx.translate(-p[0], -p[1]);
    ctx.save();
    ctx.translate(this.view.tx, this.view.ty); ctx.scale(this.view.s, this.view.s);
    ctx.drawImage(this.image, 0, 0);
    ctx.restore();
    ctx.lineWidth = 1 / zoom;
    if (this.cb.draw) this.cb.draw(ctx, this, true);
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = '#e85d04'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx - 12, cy); ctx.lineTo(cx + 12, cy); ctx.moveTo(cx, cy - 12); ctx.lineTo(cx, cy + 12); ctx.stroke();
    ctx.restore();
  }
}
