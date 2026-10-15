// Runs interior-detail detection on an image in Node (no browser) and writes an overlay for eyeballing.
// Usage: node tests/details-probe.mjs <rgba.raw> <w> <h> <ppi> <outer.json|rect> <out.json> [sensitivity] [minSize]
import fs from 'fs';
import { createRequire } from 'module';
import { findDetails } from '../src/details.js';
const require = createRequire(import.meta.url);
let cv = require('@techstark/opencv-js');
await new Promise((res) => { const t = () => (cv.Mat ? res() : setTimeout(t, 50)); t(); });
const [raw, w, h, ppi, outerArg, out, sens = '5', minSize = '0.75'] = process.argv.slice(2);
const W = +w, H = +h;
const data = fs.readFileSync(raw);
const mat = new cv.Mat(H, W, cv.CV_8UC4);
mat.data.set(data);
const outer = outerArg === 'rect' ? [[1, 1], [W - 2, 1], [W - 2, H - 2], [1, H - 2]] : JSON.parse(fs.readFileSync(outerArg, 'utf8'));
globalThis.__DBG = !!process.env.DBG;
const t0 = Date.now();
const r = findDetails(cv, mat, outer, +ppi, { sensitivity: +sens, minSize: +minSize });
const ms = Date.now() - t0;
fs.writeFileSync(out, JSON.stringify({ ms, threshold: r.threshold, shapes: r.shapes }));
fs.writeFileSync(out + '.edges.raw', Buffer.from(r.edges.mat.data));
console.log('edges', r.edges.mat.cols, r.edges.mat.rows, r.edges.x0, r.edges.y0);
console.log(`${r.shapes.length} shapes in ${ms} ms (edge threshold ${r.threshold.toFixed(1)})`);
for (const s of r.shapes) console.log(` ${s.closed ? 'closed' : 'open  '} ${s.size.w.toFixed(2)} x ${s.size.h.toFixed(2)} in  -> ${s.guess.cut}`);
process.exit(0);
