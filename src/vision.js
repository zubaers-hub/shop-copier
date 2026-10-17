// Photo work: perspective correction (homography) and outline detection (OpenCV.js, loaded on first use).
import { homography, applyH, invertH, bboxOf } from './core.js';
import { findDetails, regionAt, freeDetails } from './details.js';

// Loads a File/Blob into an image no bigger than maxSide pixels on its long side. Returns a canvas.
export async function loadPhoto(blob, maxSide = 2400) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally { URL.revokeObjectURL(url); }
}

export const canvasToBlob = (c, type = 'image/jpeg', q = 0.88) => new Promise((res) => c.toBlob(res, type, q));

// Straightens the photo so the tapped rectangle (corners TL,TR,BR,BL in photo px) becomes a true
// W x H inch rectangle. Returns { canvas, ppi, ox, oy }: canvas pixel (u,v) = inches (ox + u/ppi, oy + v/ppi),
// with inches measured from the rectangle's top-left corner.
// fill color for the parts of the straightened canvas the photo doesn't reach
const OFF_PHOTO = [43, 47, 54];
export function straighten(photo, corners, W, H, maxSide = 2000) {
  const Hm = homography(corners, [[0, 0], [W, 0], [W, H], [0, H]]);
  if (!Hm) throw new Error('Those 4 corners don’t make a usable rectangle. Move them and try again.');
  const pw = photo.width, ph = photo.height;
  // how far the rest of the photo reaches once flattened, kept within a sensible margin around the rectangle
  const reach = [[0, 0], [pw, 0], [pw, ph], [0, ph], [pw / 2, 0], [pw, ph / 2], [pw / 2, ph], [0, ph / 2]]
    .map(([x, y]) => applyH(Hm, x, y)).filter((p) => isFinite(p[0]) && isFinite(p[1]));
  const m = Math.max(W, H) * 0.75;
  const bb = bboxOf(reach.length ? reach : [[0, 0], [W, H]]);
  const ox = Math.max(bb.minX, -m), oy = Math.max(bb.minY, -m);
  const ex = Math.min(bb.maxX, W + m), ey = Math.min(bb.maxY, H + m);
  const bw = Math.max(ex - ox, W), bh = Math.max(ey - oy, H);
  const ppi = Math.max(8, Math.min(60, maxSide / Math.max(bw, bh)));
  const cw = Math.round(bw * ppi), ch = Math.round(bh * ppi);
  const src = photo.getContext('2d').getImageData(0, 0, pw, ph).data;
  const out = document.createElement('canvas');
  out.width = cw; out.height = ch;
  const octx = out.getContext('2d');
  const od = octx.createImageData(cw, ch);
  const D = od.data;
  const Hi = invertH(Hm);
  for (let v = 0; v < ch; v++) {
    const yIn = oy + (v + 0.5) / ppi;
    for (let u = 0; u < cw; u++) {
      const xIn = ox + (u + 0.5) / ppi;
      const w = Hi[6] * xIn + Hi[7] * yIn + Hi[8];
      const sx = (Hi[0] * xIn + Hi[1] * yIn + Hi[2]) / w - 0.5;
      const sy = (Hi[3] * xIn + Hi[4] * yIn + Hi[5]) / w - 0.5;
      const o = (v * cw + u) * 4;
      if (w <= 0 || sx < 0 || sy < 0 || sx >= pw - 1 || sy >= ph - 1) { D[o] = OFF_PHOTO[0]; D[o + 1] = OFF_PHOTO[1]; D[o + 2] = OFF_PHOTO[2]; D[o + 3] = 255; continue; }
      const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * pw + x0) * 4, i10 = i00 + 4, i01 = i00 + pw * 4, i11 = i01 + 4;
      for (let c = 0; c < 3; c++) {
        D[o + c] = (src[i00 + c] * (1 - fx) + src[i10 + c] * fx) * (1 - fy) + (src[i01 + c] * (1 - fx) + src[i11 + c] * fx) * fy;
      }
      D[o + 3] = 255;
    }
  }
  octx.putImageData(od, 0, 0);
  return { canvas: out, ppi, ox, oy };
}

// ---------------------------------------------------------------- OpenCV

let cvReady = null;
export function loadOpenCV() {
  if (cvReady) return cvReady;
  cvReady = new Promise((resolve, reject) => {
    // The Emscripten module is a "thenable" that resolves to itself, so awaiting it hangs.
    // Poll for cv.Mat instead (the WASM runtime finishes a moment after the script loads).
    const done = () => {
      const t0 = Date.now();
      const tick = () => {
        const cv = window.cv;
        // resolving with a thenable would hang the same way, so drop .then once it's ready
        if (cv && cv.Mat) { try { delete cv.then; } catch {} if (cv.then) cv.then = undefined; resolve(cv); return; }
        if (Date.now() - t0 > 60000) { cvReady = null; reject(new Error('The edge-detection library didn’t start. Use “Draw by hand” instead.')); return; }
        setTimeout(tick, 100);
      };
      tick();
    };
    if (window.cv) { done(); return; }
    const s = document.createElement('script');
    s.src = 'opencv.js';
    s.async = true;
    s.onload = done;
    s.onerror = () => { cvReady = null; reject(new Error('Could not load the edge-detection library. Use “Draw by hand” instead.')); };
    document.head.appendChild(s);
  });
  return cvReady;
}

// Finds a part outline on the straightened image.
//   mode: 'edges' (any photo), 'dark' (dark part / template on a light background), 'light' (light on dark)
//   sensitivity: 1..10 (higher finds fainter edges)
//   seed: optional [x,y] canvas px inside the part
// Returns { outer: [[x,y]...], holes: [[[x,y]...]...] } in canvas pixels, or null.
export async function detectOutline(canvas, { mode = 'edges', sensitivity = 5, seed = null } = {}) {
  const cv = await loadOpenCV();
  const mats = [];
  const M = (m) => { mats.push(m); return m; };
  try {
    const src = M(cv.imread(canvas));
    const gray = M(new cv.Mat());
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const blur = M(new cv.Mat());
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    const mask = M(new cv.Mat());
    const k3 = M(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3)));
    let allowHoles = true;
    if (mode === 'edges') {
      allowHoles = false; // panel lines and grain inside a part would look like cutouts
      const lo = 15 + (10 - sensitivity) * 9;
      const edges = M(new cv.Mat());
      cv.Canny(blur, edges, lo, lo * 2.5);
      // also look for color edges: an orange door on a gray wall can have almost the same brightness
      const chans = M(new cv.MatVector());
      cv.split(src, chans);
      for (let c = 0; c < 3; c++) {
        const ch = chans.get(c), ce = new cv.Mat();
        cv.GaussianBlur(ch, ch, new cv.Size(5, 5), 0);
        cv.Canny(ch, ce, lo, lo * 2.5);
        cv.bitwise_or(edges, ce, edges);
        ch.delete(); ce.delete();
      }
      const dil = M(new cv.Mat());
      cv.dilate(edges, dil, k3, new cv.Point(-1, -1), 2);
      // the area beyond the photo's own edges (filled flat by straighten) counts as background, so the
      // line where the photo ends doesn't wall the real background in with the part
      const off = M(new cv.Mat());
      const lo3 = M(new cv.Mat(src.rows, src.cols, src.type(), new cv.Scalar(...OFF_PHOTO, 255)));
      cv.inRange(src, lo3, lo3, off);
      cv.dilate(off, off, k3, new cv.Point(-1, -1), 5);
      dil.setTo(new cv.Scalar(0), off);
      // fill every region the edges enclose: flood the background in from the border
      const filled = M(dil.clone());
      const ffMask = M(cv.Mat.zeros(filled.rows + 2, filled.cols + 2, cv.CV_8U));
      for (let x = 0; x < filled.cols; x += 4) {
        for (const y of [0, filled.rows - 1]) if (filled.ucharPtr(y, x)[0] === 0) cv.floodFill(filled, ffMask, new cv.Point(x, y), new cv.Scalar(128));
      }
      for (let y = 0; y < filled.rows; y += 4) {
        for (const x of [0, filled.cols - 1]) if (filled.ucharPtr(y, x)[0] === 0) cv.floodFill(filled, ffMask, new cv.Point(x, y), new cv.Scalar(128));
      }
      cv.threshold(filled, mask, 200, 255, cv.THRESH_BINARY); // edges (255) stay; enclosed (0) -> fill next
      const inv = M(new cv.Mat());
      cv.threshold(filled, inv, 0, 255, cv.THRESH_BINARY_INV); // enclosed regions were left at 0
      cv.bitwise_or(mask, inv, mask);
      cv.erode(mask, mask, k3, new cv.Point(-1, -1), 2); // undo the dilation so the outline isn't fat
    } else {
      cv.threshold(blur, mask, 0, 255, (mode === 'dark' ? cv.THRESH_BINARY_INV : cv.THRESH_BINARY) + cv.THRESH_OTSU);
      const k5 = M(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5)));
      cv.morphologyEx(mask, mask, cv.MORPH_OPEN, k5);
      cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, k5);
    }
    const contours = M(new cv.MatVector());
    const hier = M(new cv.Mat());
    cv.findContours(mask, contours, hier, cv.RETR_CCOMP, cv.CHAIN_APPROX_NONE);
    const area = canvas.width * canvas.height;
    let best = -1, bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      if (hier.intPtr(0, i)[3] !== -1) continue; // only outer contours
      const c = contours.get(i);
      const a = cv.contourArea(c);
      const r = cv.boundingRect(c);
      const touchesAll = r.x <= 1 && r.y <= 1 && r.x + r.width >= canvas.width - 1 && r.y + r.height >= canvas.height - 1;
      let ok = a > area * 0.002 && !touchesAll;
      if (ok && seed) ok = cv.pointPolygonTest(c, new cv.Point(seed[0], seed[1]), false) >= 0;
      // with a seed: the smallest outline around it; without: the biggest
      if (ok && (best < 0 || (seed ? a < bestArea : a > bestArea))) { best = i; bestArea = a; }
      c.delete();
    }
    if (best < 0) return null;
    const toPts = (c) => { const d = c.data32S, out = []; for (let k = 0; k < d.length; k += 2) out.push([d[k], d[k + 1]]); return out; };
    const oc = contours.get(best);
    const outer = toPts(oc); oc.delete();
    const holes = [];
    if (allowHoles) {
      for (let j = hier.intPtr(0, best)[2]; j !== -1; j = hier.intPtr(0, j)[0]) {
        const hc = contours.get(j);
        if (cv.contourArea(hc) > bestArea * 0.002) holes.push(toPts(hc));
        hc.delete();
      }
    }
    return { outer, holes };
  } finally {
    mats.forEach((m) => { try { m.delete(); } catch { /* already freed */ } });
  }
}

// Finds a four-sided outline in the photo (a door, a panel). hint: 4 rough corners in photo px (from Claude),
// ordered TL, TR, BR, BL; the quad closest to them wins. Without a hint, the biggest one that isn't the
// whole photo. Returns 4 corners in photo px (same order), or null.
export async function findQuad(photo, hint = null) {
  const cv = await loadOpenCV();
  const mats = [];
  const M = (m) => { mats.push(m); return m; };
  try {
    const k = Math.min(1, 1600 / Math.max(photo.width, photo.height));
    const full = M(cv.imread(photo));
    const src = M(new cv.Mat());
    cv.resize(full, src, new cv.Size(Math.round(photo.width * k), Math.round(photo.height * k)), 0, 0, cv.INTER_AREA);
    const W = src.cols, H = src.rows;
    const edges = M(cv.Mat.zeros(H, W, cv.CV_8U));
    const chans = M(new cv.MatVector());
    cv.split(src, chans);
    const gray = M(new cv.Mat());
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    for (const ch of [gray, chans.get(0), chans.get(1), chans.get(2)]) {
      const b = new cv.Mat(), e = new cv.Mat();
      cv.GaussianBlur(ch, b, new cv.Size(5, 5), 0);
      cv.Canny(b, e, 40, 110);
      cv.bitwise_or(edges, e, edges);
      b.delete(); e.delete();
      if (ch !== gray) ch.delete();
    }
    cv.dilate(edges, edges, M(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3))));
    const cs = M(new cv.MatVector()), hh = M(new cv.Mat());
    cv.findContours(edges, cs, hh, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const diag = Math.hypot(W, H);
    const h = hint ? hint.map(([x, y]) => [x * k, y * k]) : null;
    let best = null;
    for (let i = 0; i < cs.size(); i++) {
      const c = cs.get(i);
      const area = cv.contourArea(c);
      if (area < W * H * 0.01 || area > W * H * 0.97) { c.delete(); continue; }
      const hull = new cv.Mat();
      cv.convexHull(c, hull);
      const ap = new cv.Mat();
      cv.approxPolyDP(hull, ap, 0.02 * cv.arcLength(hull, true), true);
      if (ap.rows === 4) {
        const d = ap.data32S;
        const q = orderQuad([[d[0], d[1]], [d[2], d[3]], [d[4], d[5]], [d[6], d[7]]]);
        const a = Math.abs(quadArea(q));
        let score;
        if (h) {
          const dist = q.reduce((t, p, j) => t + Math.hypot(p[0] - h[j][0], p[1] - h[j][1]), 0) / 4;
          score = dist < 0.06 * diag ? dist : null;
        } else {
          const touches = q.some(([x, y]) => x < 3 || y < 3 || x > W - 4 || y > H - 4);
          score = touches ? null : -a;
        }
        if (score !== null && (!best || score < best.score)) best = { q, score };
      }
      hull.delete(); ap.delete(); c.delete();
    }
    return best ? best.q.map(([x, y]) => [x / k, y / k]) : null;
  } finally {
    mats.forEach((m) => { try { m.delete(); } catch { /* already freed */ } });
  }
}
// TL, TR, BR, BL
function orderQuad(q) {
  const s = q.map(([x, y]) => x + y), d = q.map(([x, y]) => x - y);
  const tl = q[s.indexOf(Math.min(...s))], br = q[s.indexOf(Math.max(...s))];
  const tr = q[d.indexOf(Math.max(...d))], bl = q[d.indexOf(Math.min(...d))];
  return [tl, tr, br, bl];
}
function quadArea(q) { let a = 0; for (let i = 0; i < 4; i++) { const p = q[i], r = q[(i + 1) % 4]; a += p[0] * r[1] - r[0] * p[1]; } return a / 2; }

// Evens out a pixel-staircase outline into points about `step` inches apart (each one the average of the
// pixels around it), so the cleanup sees a steady trace and the editor isn't flooded with handles.
export function resampleOutline(pts, step) {
  const n = pts.length;
  if (n < 3) return pts;
  const out = [];
  let acc = [0, 0], cnt = 0, run = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    acc[0] += p[0]; acc[1] += p[1]; cnt++;
    run += Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (run >= step) { out.push([acc[0] / cnt, acc[1] / cnt]); acc = [0, 0]; cnt = 0; run = 0; }
  }
  if (cnt) out.push([acc[0] / cnt, acc[1] / cnt]);
  return out;
}

// Same as resampleOutline, for an open line: keeps both end points.
export function resampleLine(pts, step) {
  const n = pts.length;
  if (n < 3) return pts;
  const out = [pts[0]];
  let acc = [0, 0], cnt = 0, run = 0;
  for (let i = 1; i < n - 1; i++) {
    const p = pts[i];
    acc[0] += p[0]; acc[1] += p[1]; cnt++;
    run += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
    if (run >= step) { out.push([acc[0] / cnt, acc[1] / cnt]); acc = [0, 0]; cnt = 0; run = 0; }
  }
  out.push(pts[n - 1]);
  return out;
}

// ---------------------------------------------------------------- interior details

// Finds details inside the outline on the straightened canvas. outerPx: outline in canvas px.
// Keeps the edge map so a tap can add the area around a point (detailAt). Call freeDetailEdges when done.
export async function detectDetails(canvas, outerPx, ppi, opts) {
  const cv = await loadOpenCV();
  const src = cv.imread(canvas);
  try {
    return findDetails(cv, src, outerPx, ppi, opts);
  } finally { src.delete(); }
}
export async function detailAt(found, pointPx) {
  const cv = await loadOpenCV();
  return regionAt(cv, found, pointPx);
}
export const freeDetailEdges = (found) => freeDetails(found);
