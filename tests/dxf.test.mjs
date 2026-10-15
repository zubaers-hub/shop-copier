// DXF export test: builds sample shapes from noisy "traced" points (like the app's edge detection gives),
// cleans them with the same code the app uses, writes DXF files, then re-opens and checks them.
// Run: node tests/dxf.test.mjs   (writes tests/out/*.dxf and tests/out/report.json)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildShape, writeDXF, checkDXF, parseDXF, segPoints, parseInches, formatInches, homography, applyH, invertH,
  orderCorners, loopIsClosed, autoCenter,
} from '../src/core.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, process.env.SEED ? `out-seed-${process.env.SEED}` : 'out');
fs.mkdirSync(outDir, { recursive: true });

let failures = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// Deterministic noise so runs are repeatable.
let seed = Number(process.env.SEED || 12345);
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

const L = (a, b) => ({ type: 'line', a, b });
const A = (a, m, b) => ({ type: 'arc', a, m, b });

// Turns ideal segments into what edge detection on a corrected photo gives: dense points on a pixel grid
// with about 1 px of wobble. ppi = pixels per inch of the corrected photo.
function traced(segs, ppi = 25, noisePx = 1.0) {
  const pts = [];
  for (const s of segs) {
    const sp = s.type === 'line' ? densify(s.a, s.b, 0.08) : segPoints(s, 0.08);
    sp.slice(0, -1).forEach((p) => pts.push(p));
  }
  return pts.map(([x, y]) => ({
    x: Math.round(x * ppi + gauss() * noisePx) / ppi,
    y: Math.round(y * ppi + gauss() * noisePx) / ppi,
  }));
}
function densify(a, b, step) {
  const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
  return Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
}
// Same as the app's "Find center" button.
const centerOf = (pts) => autoCenter(pts);

function verifyFile(label, file, shape, expectW, expectH, { symmetric = false, expectLoops = 1 } = {}) {
  const text = fs.readFileSync(file, 'utf8');
  const r = checkDXF(text);
  const tol = 1 / 16;
  check(`${label}: re-opened, only LINE and ARC entities`, r.kinds.every((k) => k === 'LINE' || k === 'ARC'), `kinds=${r.kinds.join(',')}, ${r.lines} lines, ${r.arcs} arcs`);
  check(`${label}: every contour closed`, r.closedLoops === r.loops && r.loops === expectLoops, `${r.closedLoops}/${r.loops} closed, expected ${expectLoops}`);
  check(`${label}: units`, r.version === 'AC1009' || r.insunits === 1, r.version === 'AC1009' ? 'R12 (no units field in R12; values are inches)' : `$INSUNITS=${r.insunits} (inches)`);
  check(`${label}: lower-left at 0,0`, !r.problems.some((p) => p.includes('Lower-left')), r.problems.join(' ') || 'min x,y = 0,0');
  check(`${label}: width ${formatInches(expectW)}`, Math.abs(r.width - expectW) <= tol, `got ${formatInches(r.width)} (${r.width.toFixed(4)}")`);
  check(`${label}: height ${formatInches(expectH)}`, Math.abs(r.height - expectH) <= tol, `got ${formatInches(r.height)} (${r.height.toFixed(4)}")`);
  if (symmetric) {
    const ents = parseDXF(text).entities;
    const ends = ents.flatMap((e) => [e.a, e.b]);
    const W = r.width;
    const worst = Math.max(...ends.map((p) => Math.min(...ends.map((q) => Math.hypot(q[0] - (W - p[0]), q[1] - p[1])))));
    check(`${label}: mirror-symmetric`, worst < 1e-4, `worst mismatch ${worst.toExponential(1)}"`);
  }
  return r;
}

// ------------------------------------------------------------- unit checks
check('fractions: "14 3/4" -> 14.75', parseInches('14 3/4') === 14.75);
check('fractions: 14-3/4" -> 14.75', parseInches('14-3/4"') === 14.75);
check("fractions: 1' 2 1/2 -> 14.5", parseInches("1' 2 1/2") === 14.5);
check('fractions: 3/8 -> 0.375', parseInches('3/8') === 0.375);
check('fractions: 34.5 -> 34 1/2"', formatInches(34.5) === '34 1/2"', formatInches(34.5));
check('fractions: 14.7 -> 14 11/16"', formatInches(14.7) === '14 11/16"', formatInches(14.7));
{
  const quad = orderCorners([[812, 140], [95, 160], [140, 990], [760, 1010]]);
  const H = homography(quad, [[0, 0], [600, 0], [600, 900], [0, 900]]);
  const back = applyH(invertH(H), 300, 450);
  const fwd = applyH(H, back[0], back[1]);
  check('homography: corners map to a true rectangle and invert cleanly',
    Math.hypot(fwd[0] - 300, fwd[1] - 450) < 1e-6 && quad[0][0] === 95, `TL=${quad[0]}`);
}

// ------------------------------------------------------------- sample 1: arched door top (mirrored)
const doorIdeal = [
  L([0, 27], [15, 27]),
  L([15, 27], [15, 3]),
  A([15, 3], [7.5, 0], [0, 3]),
  L([0, 3], [0, 27]),
];
{
  const raw = traced(doorIdeal);
  const shape = buildShape({ outer: raw, holes: [] }, { mirror: { on: true, cx: centerOf(raw), keep: 'left' }, smooth: 3 });
  check('arched door: cleaned outline is a closed loop', loopIsClosed(shape.outer), `${shape.outer.length} segments: ${shape.outer.map((s) => s.type).join(', ')}`);
  for (const version of ['R2000', 'R12']) {
    const file = path.join(outDir, `arched-door-top-${version}.dxf`);
    fs.writeFileSync(file, writeDXF(shape, { version }));
    verifyFile(`arched door ${version}`, file, shape, 15, 27, { symmetric: true });
  }
}

// ------------------------------------------------------------- sample 2: symmetric corbel with a round cutout
const half = [ // right half, then mirrored to build the ideal outline
  L([3, 0], [6, 0]),
  L([6, 0], [6, 1.5]),
  A([6, 1.5], [5.15, 2.75], [4.5, 4.5]),
  A([4.5, 4.5], [4.75, 6.4], [4.25, 8]),
  L([4.25, 8], [4.25, 10]),
  L([4.25, 10], [3, 10]),
];
const mirrorX = (p) => [6 - p[0], p[1]];
const corbelIdeal = [
  ...half,
  ...half.map((s) => ({ ...s, a: mirrorX(s.b), b: mirrorX(s.a), ...(s.m ? { m: mirrorX(s.m) } : {}) })).reverse(),
];
const hole = [A([2.5, 2.5], [3, 2], [3.5, 2.5]), A([3.5, 2.5], [3, 3], [2.5, 2.5])];
{
  const raw = traced(corbelIdeal);
  const rawHole = traced(hole);
  const shape = buildShape({ outer: raw, holes: [rawHole] }, { mirror: { on: true, cx: centerOf(raw), keep: 'left' }, smooth: 3 });
  check('corbel: outline and cutout are closed loops', loopIsClosed(shape.outer) && shape.holes.length === 1 && loopIsClosed(shape.holes[0]),
    `outline ${shape.outer.length} segs (${shape.outer.filter((s) => s.type === 'arc').length} arcs), cutout ${shape.holes[0]?.length} segs`);
  for (const version of ['R2000', 'R12']) {
    const file = path.join(outDir, `corbel-${version}.dxf`);
    fs.writeFileSync(file, writeDXF(shape, { version }));
    verifyFile(`corbel ${version}`, file, shape, 6, 10, { symmetric: true, expectLoops: 2 });
  }
}

// ------------------------------------------------------------- sample 3: corbel traced by hand, left half only
{
  // A few finger taps on the left half, ending on the centerline (x = 3). Mirror finishes the shape.
  const taps = [
    { x: 3, y: 0 }, { x: 0, y: 0, corner: true }, { x: 0, y: 1.5, corner: true },
    { x: 0.55, y: 2.2 }, { x: 0.95, y: 3.1 }, { x: 1.5, y: 4.5, corner: true },
    { x: 1.32, y: 5.6 }, { x: 1.35, y: 6.9 }, { x: 1.75, y: 8, corner: true },
    { x: 1.75, y: 10, corner: true }, { x: 3, y: 10 },
  ];
  const shape = buildShape({ outer: taps, holes: [] }, { mirror: { on: true, cx: 3, keep: 'left' }, smooth: 2 });
  const file = path.join(outDir, 'corbel-hand-traced-R2000.dxf');
  fs.writeFileSync(file, writeDXF(shape, { version: 'R2000' }));
  verifyFile('hand-traced half corbel', file, shape, 6, 10, { symmetric: true });
}

// ------------------------------------------------------------- sample 4: cathedral door top (mirrored)
{
  const cath = [
    L([0, 30], [16, 30]), L([16, 30], [16, 4]),
    A([16, 4], [12.6, 1.25], [8, 0]), A([8, 0], [3.4, 1.25], [0, 4]),
    L([0, 4], [0, 30]),
  ];
  const raw = traced(cath);
  const shape = buildShape({ outer: raw, holes: [] }, { mirror: { on: true, cx: centerOf(raw), keep: 'right' }, smooth: 3 });
  const file = path.join(outDir, 'cathedral-door-top-R2000.dxf');
  fs.writeFileSync(file, writeDXF(shape, { version: 'R2000' }));
  verifyFile('cathedral door (mirrored, kept right half)', file, shape, 16, 30, { symmetric: true });
}

// ------------------------------------------------------------- sample 5: arched door top with mirror OFF
{
  const raw = traced(doorIdeal);
  const shape = buildShape({ outer: raw, holes: [] }, { mirror: { on: false }, smooth: 3 });
  const file = path.join(outDir, 'arched-door-top-no-mirror-R2000.dxf');
  fs.writeFileSync(file, writeDXF(shape, { version: 'R2000' }));
  verifyFile('arched door (mirror off)', file, shape, 15, 27);
}

fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);
