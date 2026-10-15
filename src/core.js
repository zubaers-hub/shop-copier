// Geometry core for the cabinet shop app. No DOM access, so it runs in the browser and in Node tests.
// Conventions: shape points are in INCHES in "image space" (x right, y DOWN), as measured on the
// perspective-corrected photo. DXF export flips to CAD space (y UP) and moves the lower-left corner to 0,0.

import { DXF_R2000_TEMPLATE, MODEL_SPACE_HANDLE, FIRST_FREE_HANDLE } from './dxf-template.js';

// ---------------------------------------------------------------- inches & fractions

// Parses 14 3/4, 14-3/4, 14.75, 3/4, 14 3/4", 1' 2 1/2", 1'2. Returns NaN when it can't.
export function parseInches(input) {
  if (input == null) return NaN;
  let s = String(input).trim().toLowerCase()
    .replace(/[″”"]|inches|inch|in\b/g, ' ')
    .replace(/[′’]|feet|foot|ft\b/g, "'")
    .replace(/\s+/g, ' ').trim();
  if (!s) return NaN;
  let feet = 0;
  const f = s.match(/^(-?\d+(?:\.\d+)?)\s*'\s*-?\s*(.*)$/);
  if (f) { feet = parseFloat(f[1]); s = f[2].trim(); if (!s) return feet * 12; }
  let m;
  if ((m = s.match(/^(-?\d+(?:\.\d+)?)$/))) return feet * 12 + parseFloat(m[1]);
  if ((m = s.match(/^(\d+)\s*\/\s*(\d+)$/))) return m[2] === '0' ? NaN : feet * 12 + m[1] / m[2];
  if ((m = s.match(/^(-?)(\d+)(?:\s+|\s*-\s*)(\d+)\s*\/\s*(\d+)$/))) {
    if (m[4] === '0') return NaN;
    const v = parseInt(m[2], 10) + m[3] / m[4];
    return feet * 12 + (m[1] ? -v : v);
  }
  return NaN;
}

function gcd(a, b) { return b ? gcd(b, a % b) : a; }

// 14.75 -> 14 3/4"   (rounded to the nearest 1/denom inch)
export function formatInches(v, denom = 16, mark = '"') {
  if (v == null || !isFinite(v)) return '—';
  const neg = v < 0;
  let n = Math.round(Math.abs(v) * denom);
  const whole = Math.floor(n / denom);
  let num = n - whole * denom;
  let txt;
  if (num === 0) txt = String(whole);
  else {
    const g = gcd(num, denom);
    const frac = `${num / g}/${denom / g}`;
    txt = whole ? `${whole} ${frac}` : frac;
  }
  return (neg && n ? '-' : '') + txt + mark;
}

// ---------------------------------------------------------------- small vector helpers

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const len = (a) => Math.hypot(a[0], a[1]);
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function distToSegment(p, a, b) {
  const ab = sub(b, a), l2 = dot(ab, ab);
  if (l2 < 1e-18) return dist(p, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  return dist(p, add(a, mul(ab, t)));
}

// ---------------------------------------------------------------- homography

// Solves the 3x3 homography H (h33 = 1) that maps 4 src points onto 4 dst points.
export function homography(src, dst) {
  const A = [], bvec = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); bvec.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); bvec.push(v);
  }
  const h = solve(A, bvec);
  if (!h) return null;
  return [...h, 1];
}

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

export function invertH(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const inv = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d]
    .map((v) => v / det);
  return inv.map((v) => v / inv[8]);
}

// Orders 4 tapped corners as top-left, top-right, bottom-right, bottom-left.
export function orderCorners(pts) {
  const c = pts.reduce((s, p) => [s[0] + p[0] / 4, s[1] + p[1] / 4], [0, 0]);
  const sorted = [...pts].sort((p, q) => Math.atan2(p[1] - c[1], p[0] - c[0]) - Math.atan2(q[1] - c[1], q[0] - c[0]));
  // atan2 in y-down space: sorted runs clockwise on screen starting near "left". Rotate so TL first.
  let best = 0, bestScore = Infinity;
  sorted.forEach((p, i) => { const s = p[0] + p[1]; if (s < bestScore) { bestScore = s; best = i; } });
  return [0, 1, 2, 3].map((k) => sorted[(best + k) % 4]);
}

// Rough real aspect (width/height) of a quad seen in perspective; used only when the user enters one dimension.
export function quadAspect(q) {
  const w = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2;
  const h = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
  return w / h;
}

// ---------------------------------------------------------------- circles & arcs

export function circleFrom3(a, m, b) {
  const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = dot(a, a), m2 = dot(m, m), b2 = dot(b, b);
  const cx = (a2 * (m[1] - b[1]) + m2 * (b[1] - a[1]) + b2 * (a[1] - m[1])) / d;
  const cy = (a2 * (b[0] - m[0]) + m2 * (a[0] - b[0]) + b2 * (m[0] - a[0])) / d;
  return { c: [cx, cy], r: dist([cx, cy], a) };
}

const TAU = Math.PI * 2;
const norm = (t) => ((t % TAU) + TAU) % TAU;

// Arc a->m->b as center/radius plus a start angle and positive sweep, measured counterclockwise
// in whatever coordinate system the points are in.
export function arcGeom(seg) {
  const circ = circleFrom3(seg.a, seg.m, seg.b);
  if (!circ) return null;
  const { c, r } = circ;
  const ta = Math.atan2(seg.a[1] - c[1], seg.a[0] - c[0]);
  const tm = Math.atan2(seg.m[1] - c[1], seg.m[0] - c[0]);
  const tb = Math.atan2(seg.b[1] - c[1], seg.b[0] - c[0]);
  const ccw = norm(tm - ta) < norm(tb - ta); // going counterclockwise from a we meet m before b
  return ccw
    ? { c, r, ccw, start: ta, sweep: norm(tb - ta) }
    : { c, r, ccw, start: tb, sweep: norm(ta - tb) };
}

export function segLength(s) {
  if (s.type === 'line') return dist(s.a, s.b);
  const g = arcGeom(s);
  return g ? g.r * g.sweep : dist(s.a, s.b);
}

// Points along a segment, for drawing and for bounding boxes.
export function segPoints(s, step = 0.05) {
  if (s.type === 'line') return [s.a, s.b];
  const g = arcGeom(s);
  if (!g) return [s.a, s.b];
  const n = Math.max(4, Math.ceil((g.r * g.sweep) / step));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = g.ccw ? g.start + (g.sweep * i) / n : g.start + g.sweep - (g.sweep * i) / n;
    pts.push([g.c[0] + g.r * Math.cos(t), g.c[1] + g.r * Math.sin(t)]);
  }
  pts[0] = s.a; pts[pts.length - 1] = s.b;
  return pts;
}

export function segBBox(s) {
  const pts = [s.a, s.b];
  if (s.type === 'arc') {
    const g = arcGeom(s);
    if (g) for (let k = 0; k < 4; k++) {
      const t = (k * Math.PI) / 2;
      if (norm(t - g.start) <= g.sweep + 1e-12) pts.push([g.c[0] + g.r * Math.cos(t), g.c[1] + g.r * Math.sin(t)]);
    }
  }
  return bboxOf(pts);
}

export function bboxOf(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

export function shapeBBox(shape) {
  const boxes = [shape.outer, ...shape.holes].flat().map(segBBox);
  return bboxOf(boxes.flatMap((b) => [[b.minX, b.minY], [b.maxX, b.maxY]]));
}

function transformSeg(s, f) {
  const out = { type: s.type, a: f(s.a), b: f(s.b) };
  if (s.type === 'arc') out.m = f(s.m);
  return out;
}
const reverseSeg = (s) => (s.type === 'arc' ? { type: 'arc', a: s.b, b: s.a, m: s.m } : { type: 'line', a: s.b, b: s.a });

// ---------------------------------------------------------------- polyline helpers

export function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) a += cross(pts[i], pts[(i + 1) % pts.length]);
  return a / 2;
}

// Turning angle (degrees) at each vertex of a closed polygon, looking `reach` inches along the outline each way.
export function turnAngles(pts, reach = 0.2, closed = true) {
  const n = pts.length;
  const out = new Array(n).fill(0);
  const walk = (i, dir) => {
    let acc = 0, j = i;
    for (let k = 0; k < n; k++) {
      const nj = j + dir;
      if (!closed && (nj < 0 || nj >= n)) return pts[j];
      const q = pts[(nj + n) % n];
      const d = dist(pts[(j + n) % n], q);
      if (acc + d >= reach) {
        const t = (reach - acc) / d;
        return add(pts[(j + n) % n], mul(sub(q, pts[(j + n) % n]), t));
      }
      acc += d; j = nj;
    }
    return pts[(j + n) % n];
  };
  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) { out[i] = 180; continue; }
    const p = walk(i, -1), q = walk(i, 1);
    const u = sub(pts[i], p), v = sub(q, pts[i]);
    if (len(u) < 1e-9 || len(v) < 1e-9) continue;
    out[i] = (Math.abs(Math.atan2(cross(u, v), dot(u, v))) * 180) / Math.PI;
  }
  return out;
}

// Which raw points act as corners. A point's own flag wins; otherwise sharp turns count, keeping only the
// sharpest point of each bend so a noisy traced corner gives one corner, not a cluster.
export const CORNER_REACH = 0.4;
export const CORNER_DEG = 30;
export const CORNER_DEG_CLEAN = 22;
export function cornerFlags(points, closed = true, threshold = CORNER_DEG) {
  let pts = points.map((p) => [p.x, p.y]);
  const n = pts.length;
  // traced outlines are dense and wobbly: smooth a little before measuring how sharp each bend is
  let perimLen = 0;
  for (let i = 1; i < n; i++) perimLen += dist(pts[i - 1], pts[i]);
  if (n > 8 && perimLen / n < 0.15) {
    for (let k = 0; k < 4; k++) {
      pts = pts.map((p, i) => {
        if (!closed && (i === 0 || i === n - 1)) return p;
        const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
        return [(a[0] + 2 * p[0] + b[0]) / 4, (a[1] + 2 * p[1] + b[1]) / 4];
      });
    }
  }
  // a real corner looks sharp both close up and from further away; wobble only looks sharp close up
  const a1 = turnAngles(pts, CORNER_REACH, closed), a2 = turnAngles(pts, CORNER_REACH * 2, closed);
  // ...and a smooth curve keeps turning the further you look (about twice the angle at twice the reach)
  const ang = a1.map((v, i) => (a2[i] < 1.6 * v ? Math.min(v, a2[i]) : 0));
  const auto = ang.map((a) => a >= threshold);
  // arc-length position of each point, for "nearby" tests
  const pos = [0];
  for (let i = 1; i < n; i++) pos.push(pos[i - 1] + dist(pts[i - 1], pts[i]));
  const perim = pos[n - 1] + (closed ? dist(pts[n - 1], pts[0]) : 0);
  const near = (i, j) => { const d = Math.abs(pos[i] - pos[j]); return (closed ? Math.min(d, perim - d) : d) < CORNER_REACH; };
  for (let i = 0; i < n; i++) {
    if (!auto[i] || (!closed && (i === 0 || i === n - 1))) continue;
    for (let k = 1; k < n; k++) {
      const j = closed ? (i + k) % n : i + k;
      if (j >= n || !near(i, j)) break;
      if (ang[j] > ang[i] || (ang[j] === ang[i] && j < i)) { auto[i] = false; break; }
    }
    if (!auto[i]) continue;
    for (let k = 1; k < n; k++) {
      const j = closed ? (i - k + n) % n : i - k;
      if (j < 0 || !near(i, j)) break;
      if (ang[j] > ang[i]) { auto[i] = false; break; }
    }
  }
  return points.map((p, i) => (p.corner === true ? true : p.corner === false ? false : auto[i]));
}

// Douglas-Peucker: thins a dense traced outline into a manageable set of editable points.
export function simplifyClosed(points, eps) {
  const n = points.length;
  if (n < 8) return points;
  // split at the two points farthest apart so both halves are open polylines
  let a = 0, b = 0, best = -1;
  for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 200))) for (let j = 0; j < n; j++) {
    const d = (points[i].x - points[j].x) ** 2 + (points[i].y - points[j].y) ** 2;
    if (d > best) { best = d; a = i; b = j; }
  }
  if (a > b) [a, b] = [b, a];
  const keep = new Uint8Array(n);
  keep[a] = keep[b] = 1;
  const rec = (idx) => {
    if (idx.length < 3) return;
    const p0 = [points[idx[0]].x, points[idx[0]].y], p1 = [points[idx[idx.length - 1]].x, points[idx[idx.length - 1]].y];
    let worst = 0, wi = -1;
    for (let k = 1; k < idx.length - 1; k++) {
      const d = distToSegment([points[idx[k]].x, points[idx[k]].y], p0, p1);
      if (d > worst) { worst = d; wi = k; }
    }
    if (worst > eps) { keep[idx[wi]] = 1; rec(idx.slice(0, wi + 1)); rec(idx.slice(wi)); }
  };
  const first = [], second = [];
  for (let i = a; i <= b; i++) first.push(i);
  for (let i = b; i <= a + n; i++) second.push(i % n);
  rec(first); rec(second);
  return points.filter((_, i) => keep[i]);
}

// Centripetal Catmull-Rom through the points of an open run, sampled about every `step` inches.
// Endpoints are kept exactly. This turns a few hand-placed points along a curve into a smooth curve.
function splineResample(run, step) {
  if (run.length === 2) {
    const n = Math.max(1, Math.ceil(dist(run[0], run[1]) / step));
    return Array.from({ length: n + 1 }, (_, i) => add(run[0], mul(sub(run[1], run[0]), i / n)));
  }
  const P = [sub(mul(run[0], 2), run[1]), ...run, sub(mul(run[run.length - 1], 2), run[run.length - 2])];
  const out = [run[0]];
  for (let i = 1; i < P.length - 2; i++) {
    const p0 = P[i - 1], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2];
    const segLen = dist(p1, p2);
    const n = Math.max(1, Math.ceil(segLen / step));
    const t01 = Math.pow(dist(p0, p1) || 1e-6, 0.5), t12 = Math.pow(segLen || 1e-6, 0.5), t23 = Math.pow(dist(p2, p3) || 1e-6, 0.5);
    const m1 = add(sub(p2, p1), mul(sub(mul(sub(p1, p0), 1 / t01), mul(sub(p2, p0), 1 / (t01 + t12))), t12));
    const m2 = add(sub(p2, p1), mul(sub(mul(sub(p3, p2), 1 / t23), mul(sub(p3, p1), 1 / (t12 + t23))), t12));
    for (let k = 1; k <= n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
      out.push(k === n ? p2 : add(add(mul(p1, h00), mul(m1, h10)), add(mul(p2, h01), mul(m2, h11))));
    }
  }
  return out;
}

// Light smoothing. The ends move too (one-sided), so one wobbly corner point can't bend a whole stretch;
// corners are rebuilt later from where the fitted lines and arcs meet.
function smoothRun(pts, passes) {
  let cur = pts.map((p) => [...p]);
  const n = cur.length;
  if (n < 3) return cur;
  for (let k = 0; k < passes; k++) {
    const nxt = cur.map((p) => [...p]);
    for (let i = 1; i < n - 1; i++) {
      nxt[i] = [(cur[i - 1][0] + 2 * cur[i][0] + cur[i + 1][0]) / 4, (cur[i - 1][1] + 2 * cur[i][1] + cur[i + 1][1]) / 4];
    }
    // extrapolate ends from their neighbours so straight runs stay straight and full length
    nxt[0] = [(cur[0][0] + 2 * cur[1][0] - cur[2][0]) / 2, (cur[0][1] + 2 * cur[1][1] - cur[2][1]) / 2];
    nxt[n - 1] = [(cur[n - 1][0] + 2 * cur[n - 2][0] - cur[n - 3][0]) / 2, (cur[n - 1][1] + 2 * cur[n - 2][1] - cur[n - 3][1]) / 2];
    cur = nxt;
  }
  return cur;
}

// ---------------------------------------------------------------- line & arc fitting
//
// How cleanup works, for a traced outline (dense and wobbly) or a hand-placed one (a few points):
//  1. split it at corners, and run a smooth curve through each stretch between corners
//  2. cover each stretch, greedily, with the fewest best-fit lines and circles that stay within tolerance
//     (best fit over all the points, so no single wobbly point decides where an edge is)
//  3. join neighbours that turn out to be one line or one circle (this also removes false corners)
//  4. square up lines that are within a few degrees of level or plumb
//  5. put every corner exactly where neighbouring lines/circles meet
// Result: a closed chain of LINE and ARC pieces that meet exactly end to end.

function lsqLine(pts, axisLockDeg = 0) {
  const n = pts.length;
  const c = pts.reduce((s, p) => [s[0] + p[0] / n, s[1] + p[1] / n], [0, 0]);
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) { const dx = p[0] - c[0], dy = p[1] - c[1]; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  let th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  if (axisLockDeg) {
    const q = Math.round(th / (Math.PI / 2)) * (Math.PI / 2);
    if (Math.abs(th - q) < (axisLockDeg * Math.PI) / 180) th = q;
  }
  return { c, d: [Math.cos(th), Math.sin(th)] };
}

// err combines the typical miss (rms) and the worst miss, so one wobbly point can't block a fit
// but a real bend still does.
const fitErr = (worst, rms, k = 0.5, kr = 1.5) => Math.max(rms * kr, worst * k);

function linePrim(P) {
  const f = lsqLine(P);
  let worst = 0, ss = 0;
  for (const p of P) { const e = Math.abs(cross(sub(p, f.c), f.d)); worst = Math.max(worst, e); ss += e * e; }
  return { kind: 'line', c: f.c, d: f.d, worst, err: fitErr(worst, Math.sqrt(ss / P.length)) };
}

// Best-fit circle: algebraic (Kasa) start, then a few Gauss-Newton steps on true distance.
function circlePrim(P) {
  const n = P.length;
  if (n < 5) return null;
  const mx = P.reduce((s, p) => s + p[0], 0) / n, my = P.reduce((s, p) => s + p[1], 0) / n;
  let suu = 0, suv = 0, svv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const p of P) {
    const u = p[0] - mx, v = p[1] - my;
    suu += u * u; suv += u * v; svv += v * v;
    suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-12) return null;
  const r1 = 0.5 * (suuu + suvv), r2 = 0.5 * (svvv + svuu);
  let c = [mx + (r1 * svv - r2 * suv) / det, my + (suu * r2 - suv * r1) / det];
  let r = 0;
  for (let it = 0; it < 6; it++) {
    // r is the mean distance; then move the center to reduce the spread
    r = P.reduce((s, p) => s + dist(p, c), 0) / n;
    let jtj00 = 0, jtj01 = 0, jtj11 = 0, jtr0 = 0, jtr1 = 0;
    let mu0 = 0, mu1 = 0;
    const rows = P.map((p) => { const d = dist(p, c) || 1e-9; const j = [(c[0] - p[0]) / d, (c[1] - p[1]) / d]; mu0 += j[0] / n; mu1 += j[1] / n; return { d, j }; });
    for (const { d, j } of rows) {
      const g0 = j[0] - mu0, g1 = j[1] - mu1, res = d - r;
      jtj00 += g0 * g0; jtj01 += g0 * g1; jtj11 += g1 * g1; jtr0 += g0 * res; jtr1 += g1 * res;
    }
    const dt = jtj00 * jtj11 - jtj01 * jtj01;
    if (Math.abs(dt) < 1e-14) break;
    const step = [(jtj11 * jtr0 - jtj01 * jtr1) / dt, (jtj00 * jtr1 - jtj01 * jtr0) / dt];
    c = [c[0] - step[0], c[1] - step[1]];
    if (Math.hypot(step[0], step[1]) < 1e-7) break;
  }
  r = P.reduce((s, p) => s + dist(p, c), 0) / n;
  if (!isFinite(r) || r > 600 || r < 0.03) return null;
  let worst = 0, ss = 0;
  for (const p of P) { const e = Math.abs(dist(p, c) - r); worst = Math.max(worst, e); ss += e * e; }
  const err = fitErr(worst, Math.sqrt(ss / n), 0.67, 2); // arcs are held a little tighter than lines
  // the points must run one way round the circle, less than a full turn
  let sweep = 0, prev = Math.atan2(P[0][1] - c[1], P[0][0] - c[0]), back = 0, fwd = 0;
  for (let k = 1; k < n; k++) {
    const t = Math.atan2(P[k][1] - c[1], P[k][0] - c[0]);
    let dt = t - prev; if (dt > Math.PI) dt -= TAU; if (dt < -Math.PI) dt += TAU;
    sweep += dt; prev = t; if (dt > 0) fwd += dt; else back -= dt;
  }
  if (Math.abs(sweep) > Math.PI * 1.9 || Math.min(fwd, back) > 0.15 * Math.max(fwd, back) + 0.02) return null;
  return { kind: 'arc', c, r, worst, err };
}

// A stretch fits as a line if it can; as an arc only if it really bows (more than the tolerance),
// so a wobbly straight edge never turns into a long shallow arc.
// strict: judge by the worst point only (used when joining across a corner that was detected).
function fitPrim(P, tol, strict = false) {
  const l = linePrim(P);
  if ((strict ? l.worst : l.err) <= tol) return l;
  const c = circlePrim(P);
  if (!c || (strict ? c.worst : c.err) > tol) return null;
  // how far the fitted arc bows away from its chord
  const half = dist(projCircle(P[0], c), projCircle(P[P.length - 1], c)) / 2;
  const bow = half >= c.r ? c.r : c.r - Math.sqrt(c.r * c.r - half * half);
  return bow > tol ? c : null;
}

// Covers sample points P (one stretch) with the fewest primitives, greedily taking the longest that fits.
function coverStretch(P, tol) {
  const prims = [];
  let i = 0;
  const last = P.length - 1;
  const at = (j) => fitPrim(P.slice(i, j + 1), tol);
  while (i < last) {
    let good = Math.min(i + 1, last), goodPrim = linePrim(P.slice(i, good + 1));
    let step = 2, bad = -1;
    for (;;) {
      const j = Math.min(last, i + step);
      const pr = at(j);
      if (pr) { good = j; goodPrim = pr; if (j === last) break; step *= 2; } else { bad = j; break; }
    }
    if (bad > 0) {
      let lo = good, hi = bad;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        const pr = at(mid);
        if (pr) { lo = mid; goodPrim = pr; } else hi = mid;
      }
      good = lo;
      goodPrim = at(good) || linePrim(P.slice(i, good + 1));
    }
    prims.push({ ...goodPrim, pts: P.slice(i, good + 1) });
    i = good;
  }
  return prims;
}

// Joins neighbouring primitives that one line or circle fits. `locked[k]` = don't join prim k with k+1.
function mergePrims(prims, tol, closed) {
  let changed = true;
  while (changed && prims.length > 1) {
    changed = false;
    for (let k = 0; k < prims.length && prims.length > 1; k++) {
      const j = k + 1 < prims.length ? k + 1 : closed ? 0 : -1;
      if (j < 0 || j === k || prims[k].lockEnd) continue;
      const pts = [...prims[k].pts, ...prims[j].pts.slice(1)];
      const pr = fitPrim(pts, tol, prims[k].cornerEnd);
      if (!pr) continue;
      const merged = { ...pr, pts, lockEnd: prims[j].lockEnd, cornerEnd: prims[j].cornerEnd };
      if (j === k + 1) prims.splice(k, 2, merged);
      else { prims.splice(k, 1, merged); prims.shift(); }
      changed = true;
    }
  }
  return prims;
}

function snapPrims(prims, maxDeg = 4) {
  for (const p of prims) {
    if (p.kind !== 'line') continue;
    const th = Math.atan2(p.d[1], p.d[0]);
    const q = Math.round(th / (Math.PI / 2)) * (Math.PI / 2);
    if (Math.abs(th - q) <= (maxDeg * Math.PI) / 180) p.d = [Math.round(Math.cos(q)), Math.round(Math.sin(q))];
  }
  return prims;
}

const projLine = (h, p) => add(p.c, mul(p.d, dot(sub(h, p.c), p.d)));
const projCircle = (h, p) => { const v = sub(h, p.c); return add(p.c, mul(v, p.r / (len(v) || 1))); };
const projPrim = (h, p) => (p.kind === 'line' ? projLine(h, p) : projCircle(h, p));

function lineCircleHit(l, c, h) {
  const oc = sub(l.c, c.c);
  const b = dot(oc, l.d), cc = dot(oc, oc) - c.r * c.r;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const r1 = add(l.c, mul(l.d, -b + s)), r2 = add(l.c, mul(l.d, -b - s));
  return dist(r1, h) < dist(r2, h) ? r1 : r2;
}
function circleCircleHit(p, q, h) {
  const d = dist(p.c, q.c);
  if (d < 1e-9 || d > p.r + q.r || d < Math.abs(p.r - q.r)) return null;
  const a = (p.r * p.r - q.r * q.r + d * d) / (2 * d);
  const hh = Math.sqrt(Math.max(0, p.r * p.r - a * a));
  const u = mul(sub(q.c, p.c), 1 / d), base = add(p.c, mul(u, a)), nrm = [-u[1], u[0]];
  const r1 = add(base, mul(nrm, hh)), r2 = add(base, mul(nrm, -hh));
  return dist(r1, h) < dist(r2, h) ? r1 : r2;
}

// Where primitive p ends and q begins; h is the sample point they share.
function joinPoint(p, q, h) {
  let x = null;
  if (p.kind === 'line' && q.kind === 'line') {
    const cr = cross(p.d, q.d);
    if (Math.abs(cr) > Math.sin((3 * Math.PI) / 180)) x = add(p.c, mul(p.d, cross(sub(q.c, p.c), q.d) / cr));
  } else if (p.kind === 'line') x = lineCircleHit(p, q, h);
  else if (q.kind === 'line') x = lineCircleHit(q, p, h);
  else x = circleCircleHit(p, q, h);
  if (x && dist(x, h) < 0.5) return x;
  return mul(add(projPrim(h, p), projPrim(h, q)), 0.5); // nearly tangent: meet halfway
}

// Where primitive p crosses the vertical line x = cx (mirror centerline); h = the sample point there.
function centerHit(p, cx, h) {
  if (p.kind === 'line') {
    if (Math.abs(p.d[0]) > 0.05) { const t = (cx - p.c[0]) / p.d[0]; return [cx, p.c[1] + t * p.d[1]]; }
    return [cx, projLine(h, p)[1]];
  }
  const dx = cx - p.c[0];
  if (Math.abs(dx) <= p.r) {
    const s = Math.sqrt(p.r * p.r - dx * dx);
    const y1 = p.c[1] + s, y2 = p.c[1] - s;
    return [cx, Math.abs(y1 - h[1]) < Math.abs(y2 - h[1]) ? y1 : y2];
  }
  return [cx, projCircle(h, p)[1]];
}

function primsToSegs(prims, verts) {
  return prims.map((p, k) => {
    const a = verts[k], b = verts[k + 1];
    if (p.kind === 'line') return { type: 'line', a, b };
    const m = projCircle(p.pts[p.pts.length >> 1], p);
    return fixArc({ type: 'arc', a, b, m });
  });
}

function vertsFor(prims, closed, cx) {
  const n = prims.length;
  const verts = [];
  if (closed) {
    for (let k = 0; k < n; k++) {
      const prev = prims[(k - 1 + n) % n];
      verts.push(joinPoint(prev, prims[k], prims[k].pts[0]));
    }
    verts.push(verts[0]);
  } else {
    verts.push(cx == null ? projPrim(prims[0].pts[0], prims[0]) : centerHit(prims[0], cx, prims[0].pts[0]));
    for (let k = 1; k < n; k++) verts.push(joinPoint(prims[k - 1], prims[k], prims[k].pts[0]));
    const lp = prims[n - 1];
    const h = lp.pts[lp.pts.length - 1];
    verts.push(cx == null ? projPrim(h, lp) : centerHit(lp, cx, h));
  }
  return verts;
}

// A small piece between two others is often a corner the smoothing rounded off. If the two neighbours,
// extended to meet, stay close to that piece's points, drop it and let them meet in a sharp corner.
// At an open end (mirror centerline) a small piece is often a wobble; let the neighbour run to the end.
function sharpen(prims, tol, closed, cx) {
  const lenOf = (p) => { const a = p.pts[0], b = p.pts[p.pts.length - 1]; return p.pts.reduce((s, q, i) => (i ? s + dist(p.pts[i - 1], q) : 0), 0) || dist(a, b); };
  const devFrom = (pts, prim) => pts.reduce((m, q) => Math.max(m, dist(q, projPrim(q, prim))), 0);
  for (let guard = 0; guard < 40; guard++) {
    let done = false;
    const n = prims.length;
    if (n < (closed ? 4 : 2)) break;
    for (let k = 0; k < n && !done; k++) {
      const pk = prims[k];
      if (lenOf(pk) > 0.75) continue;
      const hasPrev = closed || k > 0, hasNext = closed || k < n - 1;
      const pi = (k - 1 + n) % n, ni = (k + 1) % n;
      const atOpenEnd = !closed && (k === 0 || k === n - 1);
      if (!atOpenEnd && (pk.lockEnd || (hasPrev && prims[pi].lockEnd))) continue;
      if (hasPrev && hasNext) {
        const p = prims[pi], q = prims[ni];
        const mid = pk.pts[pk.pts.length >> 1];
        const x = joinPoint(p, q, mid);
        const worst = pk.pts.reduce((m, pt) => Math.max(m, Math.min(dist(pt, projPrim(pt, p)), dist(pt, projPrim(pt, q)))), 0);
        if (dist(x, mid) <= 0.5 && worst <= 3 * tol) {
          const h = pk.pts.length >> 1;
          p.pts = [...p.pts, ...pk.pts.slice(1, h + 1)];
          q.pts = [...pk.pts.slice(h), ...q.pts.slice(1)];
          // refit both neighbours on what they now cover (keeps their old fit if the new one fails)
          for (const r of [p, q]) { const f = fitPrim(r.pts, tol * 1.5); if (f && f.kind === r.kind) Object.assign(r, f); }
          prims.splice(k, 1);
          done = true;
        }
      } else {
        const nb = hasPrev ? prims[pi] : prims[ni];
        if (devFrom(pk.pts, nb) <= 2 * tol) {
          nb.pts = hasPrev ? [...nb.pts, ...pk.pts.slice(1)] : [...pk.pts, ...nb.pts.slice(1)];
          if (hasPrev && pk.lockEnd) nb.lockEnd = true;
          prims.splice(k, 1);
          done = true;
        }
      }
    }
    if (!done) break;
  }
  return prims;
}

// Removes pieces too short to cut by folding them into a neighbour.
function dropTiny(prims, closed, cx, minLen = 0.02) {
  for (let guard = 0; guard < 50 && prims.length > (closed ? 2 : 1); guard++) {
    const verts = vertsFor(prims, closed, cx);
    const k = prims.findIndex((_, i) => dist(verts[i], verts[i + 1]) < minLen);
    if (k < 0) break;
    const j = k + 1 < prims.length ? k + 1 : closed ? 0 : k - 1;
    if (j < 0) break;
    const into = prims[j];
    into.pts = j > k ? [...prims[k].pts, ...into.pts.slice(1)] : [...into.pts, ...prims[k].pts.slice(1)];
    if (j < k && prims[k].lockEnd) into.lockEnd = true;
    prims.splice(k, 1);
  }
  return prims;
}

// How wobbly a traced outline is: typical distance of each point from a lightly smoothed copy,
// measured across the outline. Hand-placed (sparse) points count as no wobble.
function traceNoise(pts, closed) {
  const n = pts.length;
  if (n < 12) return 0;
  let total = 0;
  for (let i = 1; i < n; i++) total += dist(pts[i - 1], pts[i]);
  if (total / n > 0.15) return 0;
  let sm = pts;
  for (let k = 0; k < 3; k++) {
    sm = sm.map((p, i) => {
      if (!closed && (i === 0 || i === n - 1)) return p;
      const a = sm[(i - 1 + n) % n], b = sm[(i + 1) % n];
      return [(a[0] + 2 * p[0] + b[0]) / 4, (a[1] + 2 * p[1] + b[1]) / 4];
    });
  }
  const d = pts.map((p, i) => {
    const a = sm[(i - 1 + n) % n], b = sm[(i + 1) % n];
    const t = sub(b, a), l = len(t) || 1;
    return Math.abs(cross(sub(p, sm[i]), t)) / l;
  }).sort((x, y) => x - y);
  return d[Math.floor(d.length / 2)] * 1.48;
}

export function tolFor(smooth) { return 0.02 + 0.015 * smooth; }

// Finds the vertical line the outline is most nearly symmetric about (for the mirror centerline).
export function autoCenter(points) {
  if (points.length < 3) return null;
  const xs = points.map((p) => p.x);
  const minX = Math.min(...xs), maxX = Math.max(...xs), w = maxX - minX;
  const step = Math.max(1, Math.floor(points.length / 600));
  const sample = points.filter((_, i) => i % step === 0).map((p) => [p.x, p.y]);
  const poly = points.map((p) => [p.x, p.y]);
  const score = (cx) => {
    let t = 0;
    for (const p of sample) {
      const q = [2 * cx - p[0], p[1]];
      let best = Infinity;
      for (let i = 0; i < poly.length; i++) {
        const d = distToSegment(q, poly[i], poly[(i + 1) % poly.length]);
        if (d < best) best = d;
      }
      t += best;
    }
    return t / sample.length;
  };
  let lo = minX + w * 0.35, hi = minX + w * 0.65;
  let best = (lo + hi) / 2, bestScore = Infinity;
  for (let round = 0; round < 3; round++) {
    const n = 16;
    for (let k = 0; k <= n; k++) {
      const cx = lo + ((hi - lo) * k) / n;
      const sc = score(cx);
      if (sc < bestScore) { bestScore = sc; best = cx; }
    }
    const span = (hi - lo) / n;
    lo = best - span; hi = best + span;
  }
  return best;
}

// Cleans raw points (closed outline, or open chain whose ends sit on the mirror centerline cx).
function cleanPoints(points, smooth, snap, closed, cx = null) {
  const pts = points.map((p) => [p.x, p.y]);
  if (pts.length < (closed ? 3 : 2)) return [];
  const noise = traceNoise(pts, closed);
  const tol = Math.max(tolFor(smooth), 1.5 * noise);
  // clean traces (auto-detected edges) can be trusted with gentler bends; shaky hand traces can't
  const flags = cornerFlags(points, closed, noise < 0.01 ? CORNER_DEG_CLEAN : CORNER_DEG);
  let idx = flags.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
  if (closed && idx.length < 2) { // round shapes: split into two halves so each stretch has distinct ends
    const first = idx.length ? idx[0] : 0;
    idx = [first, (first + Math.floor(pts.length / 2)) % pts.length].sort((a, b) => a - b);
  }
  const passes = Math.round(smooth * smooth);
  let prims = [];
  const stretches = closed ? idx.length : idx.length - 1;
  for (let k = 0; k < stretches; k++) {
    const i0 = idx[k], i1 = idx[(k + 1) % idx.length];
    const run = [];
    for (let i = i0; ; i = (i + 1) % pts.length) { run.push(pts[i]); if (i === i1 && run.length > 1) break; }
    let dense = smoothRun(splineResample(run, 0.05), passes);
    // on a traced outline the exact corner point is uncertain by a sample or two: leave the last
    // tenth of an inch at each end out of the fit (the corner is rebuilt where the fits meet)
    if (noise > 0 && dense.length > 16) dense = dense.slice(2, -2);
    const ps = coverStretch(dense, tol);
    // a corner the user marked stays a corner; a detected one only goes if a strict fit says so
    if (points[i1].corner === true) ps[ps.length - 1].lockEnd = true;
    ps[ps.length - 1].cornerEnd = true;
    prims.push(...ps);
  }
  if (!closed) prims[prims.length - 1].lockEnd = true;
  prims = mergePrims(prims, tol, closed);
  prims = sharpen(prims, tol, closed, cx);
  prims = mergePrims(prims, tol, closed);
  if (snap) snapPrims(prims);
  prims = dropTiny(prims, closed, cx);
  const verts = vertsFor(prims, closed, cx);
  return primsToSegs(prims, verts);
}

export function cleanClosed(points, smooth, snap = true) {
  return cleanPoints(points, smooth, snap, true);
}

// Joins neighbouring finished segments that are really one line or one arc (used across the mirror seam).
function mergeSegments(segs, tol, closed) {
  let changed = true;
  const out = segs.map((s) => ({ ...s }));
  while (changed && out.length > 1) {
    changed = false;
    for (let k = 0; k < (closed ? out.length : out.length - 1) && out.length > 1; k++) {
      const s = out[k], t = out[(k + 1) % out.length];
      let merged = null;
      if (s.type === 'line' && t.type === 'line') {
        if (distToSegment(s.b, s.a, t.b) <= 1e-4 && dot(sub(s.b, s.a), sub(t.b, t.a)) > 0) merged = { type: 'line', a: s.a, b: t.b };
      } else if (s.type === 'arc' && t.type === 'arc') {
        const g1 = arcGeom(s), g2 = arcGeom(t);
        if (g1 && g2 && g1.ccw === g2.ccw && dist(g1.c, g2.c) <= tol && Math.abs(g1.r - g2.r) <= tol && g1.sweep + g2.sweep < Math.PI * 1.9) {
          const cand = { type: 'arc', a: s.a, b: t.b, m: s.b };
          const g = arcGeom(cand);
          if (g && g.ccw === g1.ccw) {
            let worst = 0;
            for (const p of [...segPoints(s, 0.1), ...segPoints(t, 0.1)]) worst = Math.max(worst, Math.abs(dist(p, g.c) - g.r));
            if (worst <= tol) merged = cand;
          }
        }
      }
      if (merged) {
        if (k + 1 < out.length) out.splice(k, 2, merged);
        else { out.splice(k, 1, merged); out.shift(); }
        changed = true;
      }
    }
  }
  return out;
}

// An arc whose middle point no longer makes sense becomes a line.
function fixArc(s) {
  if (s.type !== 'arc') return s;
  const g = arcGeom(s);
  if (!g || g.r > 600 || distToSegment(s.m, s.a, s.b) < 0.003) return { type: 'line', a: s.a, b: s.b };
  return s;
}

// ---------------------------------------------------------------- mirror

// Cuts a closed raw outline at the vertical line x = cx and returns the part on the kept side as an
// open chain that starts and ends exactly on the centerline. Returns null if it can't.
export function halfChain(points, cx, keep = 'left') {
  const side = (p) => (keep === 'left' ? cx - p.x : p.x - cx); // >= 0 means kept
  const n = points.length;
  if (n < 2) return null;
  const crossings = [];
  for (let i = 0; i < n; i++) {
    const p = points[i], q = points[(i + 1) % n];
    const sp = side(p), sq = side(q);
    if ((sp >= 0) !== (sq >= 0)) {
      const t = sp / (sp - sq);
      crossings.push({ i, t, pt: { x: cx, y: p.y + (q.y - p.y) * t, corner: true }, entering: sq >= 0 });
    }
  }
  let warning = null;
  if (crossings.length === 0) {
    // The user traced only half. The edge closest to the centerline is the cut.
    if (!points.some((p) => side(p) >= -1e-9)) return null;
    let best = 0, bestScore = Infinity;
    for (let i = 0; i < n; i++) {
      const s = Math.abs(points[i].x - cx) + Math.abs(points[(i + 1) % n].x - cx);
      if (s < bestScore) { bestScore = s; best = i; }
    }
    const chain = [];
    for (let k = 1; k <= n; k++) chain.push({ ...points[(best + k) % n] });
    chain[0] = { ...chain[0], x: cx, corner: true };
    chain[chain.length - 1] = { ...chain[chain.length - 1], x: cx, corner: true };
    return { chain, warning };
  }
  if (crossings.length > 2) warning = 'The outline crosses the centerline more than twice; only the largest piece was mirrored.';
  let best = null;
  for (let c = 0; c < crossings.length; c++) {
    const enter = crossings[c];
    if (!enter.entering) continue;
    const leave = crossings[(c + 1) % crossings.length];
    const chain = [enter.pt];
    for (let i = (enter.i + 1) % n; ; i = (i + 1) % n) {
      chain.push({ ...points[i] });
      if (i === leave.i) break;
    }
    chain.push(leave.pt);
    if (!best || chain.length > best.length) best = chain;
  }
  if (!best) return null;
  const same = (p, q) => Math.abs(p.x - q.x) < 1e-6 && Math.abs(p.y - q.y) < 1e-6;
  const chain = best.filter((p, k) => k === 0 || k === best.length - 1 ? true : !same(p, best[k - 1]) && !same(p, best[best.length - 1]));
  return { chain, warning };
}

function mirrorClosed(points, mirror, smooth, snap) {
  const hc = halfChain(points, mirror.cx, mirror.keep);
  if (!hc || hc.chain.length < 2) return { segs: [], warning: 'Nothing on the kept side of the centerline.' };
  const cx = mirror.cx;
  const half = cleanPoints(hc.chain, smooth, snap, false, cx);
  if (!half.length) return { segs: [], warning: hc.warning };
  const flip = (p) => [2 * cx - p[0], p[1]];
  const other = half.map((s) => reverseSeg(transformSeg(s, flip))).reverse();
  let segs = [...half, ...other];
  segs = mergeSegments(segs, tolFor(smooth), true);
  return { segs, warning: hc.warning };
}

// ---------------------------------------------------------------- the whole shape

// raw: { outer: [{x,y,corner?}], holes: [[...]] } in inches (image space).
// mirror: { on, cx, keep: 'left'|'right' }. smooth: 0..10.
export function buildShape(raw, { mirror = { on: false }, smooth = 3, snap = true } = {}) {
  const warnings = [];
  const one = (pts) => {
    if (!pts || pts.length < 3) return [];
    if (!mirror.on) return cleanClosed(pts, smooth, snap);
    const r = mirrorClosed(pts, mirror, smooth, snap);
    if (r.warning) warnings.push(r.warning);
    return r.segs;
  };
  const outer = one(raw.outer);
  const holes = [];
  for (const h of raw.holes || []) {
    if (!h || h.length < 3) continue;
    if (!mirror.on) { holes.push(cleanClosed(h, smooth, snap)); continue; }
    const cx = mirror.cx;
    const keptSide = (p) => (mirror.keep === 'left' ? p.x <= cx : p.x >= cx);
    const kept = h.filter(keptSide).length;
    if (kept === 0) continue; // on the side being replaced by the mirror image
    if (kept === h.length) {
      const segs = cleanClosed(h, smooth, snap);
      holes.push(segs);
      holes.push(segs.map((s) => reverseSeg(transformSeg(s, (p) => [2 * cx - p[0], p[1]]))).reverse());
    } else {
      const r = mirrorClosed(h, mirror, smooth, snap);
      if (r.segs.length) holes.push(r.segs);
    }
  }
  return { outer, holes: holes.filter((h) => h.length), warnings };
}

// ---------------------------------------------------------------- checks

export function loopIsClosed(segs, eps = 1e-6) {
  if (!segs.length) return false;
  for (let k = 0; k < segs.length; k++) if (dist(segs[k].b, segs[(k + 1) % segs.length].a) > eps) return false;
  return true;
}

// Moves CAD-space shape so the bounding box lower-left is 0,0. Input in image space (y down).
export function toCadSpace(shape) {
  const flip = (p) => [p[0], -p[1]];
  const fl = { outer: shape.outer.map((s) => transformSeg(s, flip)), holes: shape.holes.map((h) => h.map((s) => transformSeg(s, flip))) };
  const bb = shapeBBox(fl);
  const mv = (p) => [p[0] - bb.minX, p[1] - bb.minY];
  return { outer: fl.outer.map((s) => transformSeg(s, mv)), holes: fl.holes.map((h) => h.map((s) => transformSeg(s, mv))) };
}

// ---------------------------------------------------------------- DXF writing

const num = (v) => {
  const r = Math.abs(v) < 5e-10 ? 0 : v;
  return r.toFixed(6);
};
const deg = (rad) => { let d = (rad * 180) / Math.PI; d = ((d % 360) + 360) % 360; return d.toFixed(6); };

function dxfEntities(cad, version, layers) {
  const out = [];
  let handle = FIRST_FREE_HANDLE;
  const r2000 = version === 'R2000';
  const head = (type, layer) => {
    out.push('0', type);
    if (r2000) { out.push('5', (handle++).toString(16).toUpperCase(), '330', MODEL_SPACE_HANDLE, '100', 'AcDbEntity'); }
    out.push('8', layer);
  };
  const emit = (segs, layer) => {
    for (const s of segs) {
      if (s.type === 'line') {
        head('LINE', layer);
        if (r2000) out.push('100', 'AcDbLine');
        out.push('10', num(s.a[0]), '20', num(s.a[1]), '30', '0.0', '11', num(s.b[0]), '21', num(s.b[1]), '31', '0.0');
      } else {
        const g = arcGeom(s); // CAD space is y-up, so counterclockwise here is DXF's counterclockwise
        head('ARC', layer);
        if (r2000) out.push('100', 'AcDbCircle');
        out.push('10', num(g.c[0]), '20', num(g.c[1]), '30', '0.0', '40', num(g.r));
        if (r2000) out.push('100', 'AcDbArc');
        out.push('50', deg(g.start), '51', deg(g.start + g.sweep));
      }
    }
  };
  emit(cad.outer, layers.outer);
  cad.holes.forEach((h) => emit(h, layers.hole));
  return { lines: out, nextHandle: handle };
}

// shape: output of buildShape (image space, inches). Returns DXF text (CRLF line ends).
export function writeDXF(shape, { version = 'R2000', layerOuter = 'OUTLINE', layerHole = 'CUTOUT' } = {}) {
  const cad = toCadSpace(shape);
  const bb = shapeBBox(cad);
  const { lines, nextHandle } = dxfEntities(cad, version, { outer: layerOuter, hole: layerHole });
  let text;
  if (version === 'R2000') {
    let t = DXF_R2000_TEMPLATE;
    // custom layer names need table entries; the template carries OUTLINE and CUTOUT only
    if (!['OUTLINE', 'CUTOUT', '0'].includes(layerOuter) || !['OUTLINE', 'CUTOUT', '0'].includes(layerHole)) {
      t = t.replace(/\n\s*2\nOUTLINE\n/g, `\n  2\n${layerOuter}\n`).replace(/\n\s*2\nCUTOUT\n/g, `\n  2\n${layerHole}\n`);
    }
    text = t
      .replace('@@HANDSEED@@', nextHandle.toString(16).toUpperCase())
      .replace('@@MINX@@', num(bb.minX)).replace('@@MINY@@', num(bb.minY))
      .replace('@@MAXX@@', num(bb.maxX)).replace('@@MAXY@@', num(bb.maxY))
      .replace('@@ENTITIES@@', lines.join('\n'));
  } else {
    const hdr = ['0', 'SECTION', '2', 'HEADER',
      '9', '$ACADVER', '1', 'AC1009',
      '9', '$INSBASE', '10', '0.0', '20', '0.0', '30', '0.0',
      '9', '$EXTMIN', '10', num(bb.minX), '20', num(bb.minY), '30', '0.0',
      '9', '$EXTMAX', '10', num(bb.maxX), '20', num(bb.maxY), '30', '0.0',
      '9', '$LUNITS', '70', '2',
      '0', 'ENDSEC',
      '0', 'SECTION', '2', 'TABLES',
      '0', 'TABLE', '2', 'LTYPE', '70', '1',
      '0', 'LTYPE', '2', 'CONTINUOUS', '70', '0', '3', 'Solid line', '72', '65', '73', '0', '40', '0.0',
      '0', 'ENDTAB',
      '0', 'TABLE', '2', 'LAYER', '70', '3',
      ...[['0', 7], [layerOuter, 7], [layerHole, 1]].filter((l, i, a) => a.findIndex((x) => x[0] === l[0]) === i)
        .flatMap(([name, color]) => ['0', 'LAYER', '2', name, '70', '0', '62', String(color), '6', 'CONTINUOUS']),
      '0', 'ENDTAB',
      '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES', ...lines, '0', 'ENDSEC', '0', 'EOF'];
    text = hdr.join('\n');
  }
  // DXF wants group codes right-aligned in 3 columns; most readers accept either, this matches AutoCAD.
  const arr = text.split('\n');
  for (let i = 0; i < arr.length; i += 2) {
    const c = arr[i].trim();
    if (/^-?\d+$/.test(c)) arr[i] = c.padStart(3, ' ');
  }
  return arr.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- DXF reading (for the self-check)

export function parseDXF(text) {
  const raw = text.split(/\r?\n/);
  const pairs = [];
  for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([parseInt(raw[i].trim(), 10), raw[i + 1].trim()]);
  const header = {};
  const entities = [];
  let section = null, cur = null, hvar = null;
  for (const [code, val] of pairs) {
    if (code === 0) {
      if (cur) { entities.push(cur); cur = null; }
      if (val === 'SECTION') { section = 'pending'; continue; }
      if (val === 'ENDSEC') { section = null; continue; }
      if (section === 'ENTITIES') cur = { type: val, g: {} };
      continue;
    }
    if (section === 'pending' && code === 2) { section = val; continue; }
    if (section === 'HEADER') {
      if (code === 9) { hvar = val; header[hvar] = {}; } else if (hvar) header[hvar][code] = val;
    } else if (cur) cur.g[code] = val;
  }
  if (cur) entities.push(cur);
  const f = (e, c) => parseFloat(e.g[c]);
  const ents = entities.map((e) => {
    if (e.type === 'LINE') return { type: 'LINE', layer: e.g[8], a: [f(e, 10), f(e, 20)], b: [f(e, 11), f(e, 21)] };
    if (e.type === 'ARC') {
      const c = [f(e, 10), f(e, 20)], r = f(e, 40), s = (f(e, 50) * Math.PI) / 180, t = (f(e, 51) * Math.PI) / 180;
      return { type: 'ARC', layer: e.g[8], c, r, startDeg: f(e, 50), endDeg: f(e, 51), a: [c[0] + r * Math.cos(s), c[1] + r * Math.sin(s)], b: [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)] };
    }
    return { type: e.type, layer: e.g[8] };
  });
  return { header, entities: ents };
}

// Groups parsed LINE/ARC entities into loops by matching endpoints. Returns { loops, openEnds, other }.
export function dxfLoops(entities, eps = 1e-4) {
  const segs = entities.filter((e) => e.type === 'LINE' || e.type === 'ARC');
  const other = entities.filter((e) => e.type !== 'LINE' && e.type !== 'ARC');
  const used = new Array(segs.length).fill(false);
  const loops = [];
  let openEnds = 0;
  for (let s = 0; s < segs.length; s++) {
    if (used[s]) continue;
    used[s] = true;
    const loop = [segs[s]];
    const start = segs[s].a;
    let end = segs[s].b;
    let guard = 0;
    while (dist(end, start) > eps && guard++ < segs.length) {
      const k = segs.findIndex((q, i) => !used[i] && (dist(q.a, end) <= eps || dist(q.b, end) <= eps));
      if (k < 0) break;
      used[k] = true;
      loop.push(segs[k]);
      end = dist(segs[k].a, end) <= eps ? segs[k].b : segs[k].a;
    }
    const closed = dist(end, start) <= eps;
    if (!closed) openEnds += 2;
    loops.push({ segs: loop, closed });
  }
  return { loops, openEnds, other };
}

// Bounding box of parsed DXF entities (arcs include their extreme points).
export function dxfBBox(entities) {
  const pts = [];
  for (const e of entities) {
    if (e.type === 'LINE') pts.push(e.a, e.b);
    if (e.type === 'ARC') {
      pts.push(e.a, e.b);
      const s = (e.startDeg * Math.PI) / 180, sw = norm(((e.endDeg - e.startDeg) * Math.PI) / 180) || TAU;
      for (let k = 0; k < 4; k++) { const t = (k * Math.PI) / 2; if (norm(t - s) <= sw + 1e-9) pts.push([e.c[0] + e.r * Math.cos(t), e.c[1] + e.r * Math.sin(t)]); }
    }
  }
  return bboxOf(pts);
}

// Self-check run before every download and by the tests.
export function checkDXF(text) {
  const { header, entities } = parseDXF(text);
  const problems = [];
  const kinds = [...new Set(entities.map((e) => e.type))];
  const bad = kinds.filter((k) => k !== 'LINE' && k !== 'ARC');
  if (bad.length) problems.push(`Has ${bad.join(', ')} entities (only LINE and ARC allowed).`);
  const { loops, openEnds } = dxfLoops(entities);
  if (openEnds) problems.push(`${loops.filter((l) => !l.closed).length} outline(s) are not closed.`);
  const bb = dxfBBox(entities);
  if (Math.abs(bb.minX) > 1e-4 || Math.abs(bb.minY) > 1e-4) problems.push(`Lower-left corner is at ${bb.minX.toFixed(4)}, ${bb.minY.toFixed(4)} instead of 0,0.`);
  const version = header.$ACADVER ? header.$ACADVER[1] : '?';
  const insunits = header.$INSUNITS ? parseInt(header.$INSUNITS[70], 10) : null;
  if (version === 'AC1015' && insunits !== 1) problems.push('Units are not set to inches.');
  return { ok: problems.length === 0, problems, version, insunits, width: bb.w, height: bb.h, loops: loops.length,
    closedLoops: loops.filter((l) => l.closed).length, lines: entities.filter((e) => e.type === 'LINE').length,
    arcs: entities.filter((e) => e.type === 'ARC').length, kinds };
}
