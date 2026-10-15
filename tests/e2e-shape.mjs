// End-to-end test of Shape → DXF in a phone-sized Chromium, driving the real UI with taps.
// Usage: node tests/e2e-shape.mjs http://localhost:8765/  (serve dist/ first)
import { createRequire } from 'module';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { checkDXF } from '../src/core.js';
const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium, devices } = require('playwright');

const BASE = process.argv[2] || 'http://localhost:8765/';
const OUT = 'tests/e2e-out';
const truth = JSON.parse(fs.readFileSync('tests/out/truth.json', 'utf8'));
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'], acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Corbel test' : undefined));
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });
const step = (s) => console.log('·', s);

// tap at an image-space point of the current stage
async function tapImg(p) {
  const box = await page.locator('.stage-wrap canvas').boundingBox();
  const s = await page.evaluate((p) => window.__stage.toScr(p), p);
  await page.touchscreen.tap(box.x + s[0], box.y + s[1]);
  await page.waitForTimeout(120);
}

await page.goto(BASE);
await shot('01-home');
step('home');
await page.getByRole('button', { name: /Shape → DXF/ }).click();
await page.locator('input[type=file]:not([capture])').setInputFiles('tests/out/photo.jpg');
await page.waitForSelector('.stage-wrap canvas');
await page.waitForTimeout(400);
step('photo loaded');
// the app may downscale the photo; map truth px by the scale
const scale = await page.evaluate(() => window.__stage.imgW / 2000);
for (const c of [truth.paper_corners_px[2], truth.paper_corners_px[0], truth.paper_corners_px[3], truth.paper_corners_px[1]]) // any order
  await tapImg([c[0] * scale, c[1] * scale]);
await shot('02-corners');
const corners = await page.evaluate(() => window.__editor.job.corners);
step('corners ' + JSON.stringify(corners.map((c) => c.map(Math.round))));
await page.getByRole('button', { name: /Next: size/ }).click();
const inputs = page.locator('.page input');
await inputs.nth(0).fill('8 1/2');
await inputs.nth(1).fill('11');
await shot('03-size');
await page.getByRole('button', { name: /Straighten photo/ }).click();
await page.waitForSelector('.stage-wrap canvas');
await page.waitForTimeout(400);
step('straightened, ppi ' + await page.evaluate(() => window.__editor.straight.ppi.toFixed(1)));
await page.getByRole('button', { name: /Tap inside part/ }).click();
const seedPx = await page.evaluate((q) => window.__editor.px({ x: q[0], y: q[1] }), truth.corbel_inside_in_rect);
await tapImg(seedPx);
await page.locator('select').first().selectOption('dark');
await page.getByRole('button', { name: /Auto-detect/ }).click();
await page.waitForFunction(() => window.__editor.job.contours.outer.length > 10, null, { timeout: 60000 });
await page.waitForTimeout(300);
const found = await page.evaluate(() => ({ outer: window.__editor.job.contours.outer.length, holes: window.__editor.job.features.map((h) => h.pts.length) }));
step('auto-detect ' + JSON.stringify(found));
await shot('04-trace');
await page.getByRole('button', { name: /Next: details/ }).click(); // the hole found with the outline is already an inside cut
await page.waitForTimeout(300);
await page.getByRole('button', { name: /Next: clean up/ }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: /Mirror: off/ }).click();
await page.getByRole('button', { name: /Find center/ }).click();
await page.waitForTimeout(400);
await shot('05-clean');
step('clean: ' + await page.locator('.hint-badge').first().textContent());
fs.writeFileSync(`${OUT}/job-contours.json`, JSON.stringify(await page.evaluate(() => ({ contours: window.__editor.job.contours, mirror: window.__editor.job.mirror, smooth: window.__editor.job.smooth }))));
await page.getByRole('button', { name: /Next: export/ }).click();
await page.waitForTimeout(300);
await page.locator('.page input').first().fill('corbel-from-photo');
await shot('06-export');
const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download DXF/ }).click()]);
const file = `${OUT}/${dl.suggestedFilename()}`;
await dl.saveAs(file);
const [dlp] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Save PNG/ }).click()]);
await dlp.saveAs(`${OUT}/${dlp.suggestedFilename()}`);
await page.getByRole('heading').first().textContent().then((t) => step('export heading: ' + t));
await page.locator('.page').screenshot({ path: `${OUT}/06b-export-full.png` });

// reload: the job should still be there
await page.goto(BASE);
await page.waitForTimeout(500);
const saved = await page.locator('.card .name').allTextContents();
await shot('07-home-saved');
await browser.close();

const chk = checkDXF(fs.readFileSync(file, 'utf8'));
const [tw, th] = truth.corbel_size_in;
const res = {
  file, saved, errors,
  closed: chk.closedLoops === chk.loops, loops: chk.loops, onlyLinesArcs: chk.kinds.every((k) => k === 'LINE' || k === 'ARC'),
  insunits: chk.insunits, lines: chk.lines, arcs: chk.arcs,
  width: +chk.width.toFixed(4), height: +chk.height.toFixed(4), errW: +(chk.width - tw).toFixed(4), errH: +(chk.height - th).toFixed(4), problems: chk.problems,
};
res.shapeGap = JSON.parse(execFileSync('python3', ['tests/shape_error.py', file], { encoding: 'utf8' }));
res.ezdxf = execFileSync('python3', ['-c', `import ezdxf; d=ezdxf.readfile('${file}'); a=d.audit(); print(len(a.errors), d.header.get('$INSUNITS'), sorted({e.dxftype() for e in d.modelspace()}))`], { encoding: 'utf8' }).trim();
console.log(JSON.stringify(res, null, 1));
const pass = res.closed && res.onlyLinesArcs && res.insunits === 1 && res.loops === 2 && Math.abs(res.errW) <= 0.125 && Math.abs(res.errH) <= 0.125 && res.shapeGap.worst_gap_in <= 0.0625 && res.ezdxf.startsWith('0 1 ') && saved.includes('Corbel test') && !errors.length;
console.log(pass ? 'E2E PASS' : 'E2E FAIL');
process.exit(pass ? 0 : 1);
