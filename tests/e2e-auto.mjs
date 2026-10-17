// End-to-end test of the automatic Shape → DXF: photo + size only, Claude (simulated) finds the part and
// names the details, the app shows what it found, then the DXF is checked.
// Three cases: glass door with Claude, cathedral door without a key, a shaped valance from a build-sheet photo.
// Usage: node tests/e2e-auto.mjs http://localhost:8765/
import { createRequire } from 'module';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { checkDXF } from '../src/core.js';
const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium, devices } = require('playwright');

const BASE = process.argv[2] || 'http://localhost:8765/';
const OUT = 'tests/e2e-out';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(ok ? 'PASS' : 'FAIL', name, detail); };
const report = {};

const browser = await chromium.launch();
const errors = [];
const calls = [];
let locateReply = null, detailsReply = null;

async function newPage(withKey) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (dg) => dg.accept(dg.type() === 'prompt' ? 'Auto test' : undefined));
  await page.route('https://api.anthropic.com/**', async (route) => {
    const req = route.request();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const body = JSON.parse(req.postData());
    const schema = JSON.stringify(body.output_config.format.schema);
    const kind = /inside_point/.test(schema) ? 'locate' : 'details';
    calls.push({ kind, body });
    const answer = kind === 'locate' ? locateReply(body) : detailsReply(body);
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({
      id: 'msg_t', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: JSON.stringify(answer) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }) });
  });
  await page.goto(BASE);
  if (withKey) {
    await page.locator('#btn-settings').click();
    await page.locator('input[type=password]').fill('sk-ant-test-key');
    await page.getByRole('button', { name: 'Save settings' }).click();
  }
  return page;
}

async function runAuto(page, photo, W, H, tag, before = null) {
  await page.getByRole('button', { name: /Shape → DXF/ }).click();
  await page.locator('input[type=file]:not([capture])').setInputFiles(photo);
  await page.waitForSelector('input[aria-label="Width"]', { timeout: 15000 });
  const navText = await page.locator('nav.steps').innerText();
  if (before) await page.evaluate(before);
  await page.locator('input[aria-label="Width"]').fill(W);
  await page.locator('input[aria-label="Height"]').fill(H);
  await page.screenshot({ path: `${OUT}/a-${tag}-1-size.png` });
  const t0 = Date.now();
  await page.getByRole('button', { name: /Find the part/ }).click();
  await page.waitForFunction(() => /What I found \(/.test(document.body.innerText) || document.querySelector('.auto-status .bad-box'), null, { timeout: 90000 });
  const ms = Date.now() - t0;
  const err = await page.locator('.auto-status .bad-box').textContent().catch(() => null);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/a-${tag}-2-result.png` });
  await page.locator('.page').screenshot({ path: `${OUT}/a-${tag}-2-result-full.png` }).catch(() => {});
  return { navText, ms, err };
}

async function exportAndCheck(page, tag, W, H) {
  await page.getByRole('button', { name: /Looks right/ }).click();
  await page.waitForTimeout(500);
  await page.locator('.page input:not([type=checkbox])').first().fill(`auto-${tag}`);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download DXF/ }).click()]);
  const file = `${OUT}/${dl.suggestedFilename()}`;
  await dl.saveAs(file);
  const chk = checkDXF(fs.readFileSync(file, 'utf8'));
  const ez = JSON.parse(execFileSync('python3', ['tests/verify_layers.py', file], { encoding: 'utf8' }));
  check(`${tag}: DXF ok (closed, lines/arcs, inches, 0,0), size ${W} x ${H} within 1/8"`, chk.ok && ez.ok && Math.abs(chk.width - W) <= 0.125 && Math.abs(chk.height - H) <= 0.125, `${chk.width.toFixed(3)} x ${chk.height.toFixed(3)} layers ${Object.keys(chk.layers).join(',')}`);
  return { file, layers: Object.keys(chk.layers), size: [chk.width, chk.height] };
}

const feats = (page) => page.evaluate(() => window.__editor.job.features.map((f) => {
  const xs = f.pts.map((p) => p.x), ys = f.pts.map((p) => p.y);
  return { cut: f.cut, closed: f.closed !== false, w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), src: f.src, bit: f.bit, depth: f.depth };
}));
const cornerErr = (page, truth, scale = 1) => page.evaluate(([truth, scale]) => {
  const c = window.__editor.job.corners;
  return Math.max(...c.map((p, i) => Math.hypot(p[0] - truth[i][0] * scale, p[1] - truth[i][1] * scale)));
}, [truth, scale]);

// ---- 1) glass door, with Claude: Claude's corners are ~2% off; the app locks on to the door's edges
{
  const truth = JSON.parse(fs.readFileSync('tests/doors/glass.json', 'utf8'));
  const page = await newPage(true);
  const pw = 1800, ph = 2400;
  const off = [[0.018, -0.012], [-0.015, 0.016], [0.02, 0.014], [-0.017, -0.018]];
  locateReply = () => ({ found: true, part: 'glass cabinet door', rectangular: true,
    corners: truth.door_corners_px.map(([x, y], i) => ({ x: x / pw + off[i][0], y: y / ph + off[i][1] })), inside_point: { x: 0.5, y: 0.5 },
    summary: 'A door with a glass lite and a V-groove around it.', warnings: [] });
  detailsReply = (body) => {
    const text = body.messages[0].content.find((c) => c.type === 'text').text;
    const ids = [...text.matchAll(/#(\d+): closed shape, about ([\d.]+)" x ([\d.]+)"/g)].map((m) => ({ id: +m[1], w: +m[2], h: +m[3] }));
    return { summary: 'Shaker-style door with a glass lite and a decorative V-groove around it.',
      shapes: ids.map((s) => s.w > 11 ? { id: s.id, cut: 'groove', depth_in: 0.125, bit: 'v90', description: 'Decorative V-groove around the glass', confidence: 'high' }
        : { id: s.id, cut: 'inside', depth_in: 0, bit: 'none', description: 'Glass opening, cut through', confidence: 'high' }),
      missing: [], warnings: [] };
  };
  const r = await runAuto(page, 'tests/doors/glass.jpg', '15', '28', 'glass');
  check('glass: only photo + size asked for (steps Photo, Size, What I found, Export)', /Photo[\s\S]*Size[\s\S]*What I found[\s\S]*Export/.test(r.navText) && !/Corners/.test(r.navText), r.navText.replace(/\n/g, ' '));
  check('glass: automatic run finishes', !r.err, r.err || `${r.ms} ms`);
  const scale = await page.evaluate(() => window.__editor.photo.width / 1800);
  const ce = await cornerErr(page, truth.door_corners_px, scale) / scale;
  check('glass: corners locked on to the door edges (Claude was ~40 px off)', ce < 12, `worst corner ${ce.toFixed(1)} px of 1800`);
  const f = await feats(page);
  const glass = f.find((x) => x.cut === 'inside'), groove = f.find((x) => x.cut === 'groove');
  check('glass: found the glass opening as INSIDE CUT, 10 x 23', glass && Math.abs(glass.w - 10) < 0.2 && Math.abs(glass.h - 23) < 0.2, JSON.stringify(glass));
  check('glass: found the V-groove as GROOVE (V 90°, 1/8"), 11.8 x 24.8', groove && Math.abs(groove.w - 11.8) < 0.25 && Math.abs(groove.h - 24.8) < 0.25 && groove.bit === 'v90', JSON.stringify(groove));
  const listText = await page.locator('.found-list').innerText();
  check('glass: "What I found" lists outline, glass and groove in plain words', /Outline · Outside cut/.test(listText) && /Inside cut/.test(listText) && /Glass opening/.test(listText) && /V-groove/i.test(listText), listText.replace(/\n/g, ' | ').slice(0, 300));
  const loc = calls.find((c) => c.kind === 'locate'), det = calls.find((c) => c.kind === 'details');
  check('glass: Claude was asked to find the part (with the size) and to name the details', loc && /15" wide and 28" tall/.test(loc.body.messages[0].content.find((c) => c.type === 'text').text) && det && det.body.model === 'claude-sonnet-5-5', `locate model ${loc?.body.model}`);
  report.glass = { features: f, cornerErrPx: ce, ms: r.ms, dxf: await exportAndCheck(page, 'glass', 15, 28) };
  await page.context().close();
}

// ---- 2) cathedral door, no key: the app finds the door and its details on its own
{
  const truth = JSON.parse(fs.readFileSync('tests/doors/cathedral.json', 'utf8'));
  const page = await newPage(false);
  calls.length = 0;
  const r = await runAuto(page, 'tests/doors/cathedral.jpg', '15', '28', 'cathedral');
  check('cathedral (no key): automatic run finishes without Claude', !r.err && calls.length === 0, r.err || `${r.ms} ms, ${calls.length} Claude calls`);
  const scale = await page.evaluate(() => window.__editor.photo.width / 1800);
  const ce = await cornerErr(page, truth.door_corners_px, scale) / scale;
  check('cathedral (no key): found the door’s corners from the photo', ce < 12, `worst corner ${ce.toFixed(1)} px`);
  const f = await feats(page);
  const prof = f.find((x) => x.cut === 'profile');
  check('cathedral (no key): found the raised-panel opening as PROFILE EDGE, 10 x 21.5', prof && Math.abs(prof.w - 10) < 0.3 && Math.abs(prof.h - 21.5) < 0.3, JSON.stringify(f));
  const notes = await page.locator('.note').first().innerText();
  check('cathedral (no key): says cut types are guesses without a Claude key', /Claude key/.test(notes), notes.slice(0, 160));
  report.cathedral = { features: f, cornerErrPx: ce, ms: r.ms, dxf: await exportAndCheck(page, 'cathedral', 15, 28) };
  await page.context().close();
}

// ---- 3) a shaped part: the arched valance in the kitchen photo, straight on
{
  const page = await newPage(true);
  calls.length = 0;
  locateReply = () => ({ found: true, part: 'arched valance', rectangular: false,
    corners: [{ x: 0.2813, y: 0.08 }, { x: 0.75, y: 0.08 }, { x: 0.75, y: 0.2 }, { x: 0.2813, y: 0.2 }], inside_point: { x: 0.5, y: 0.11 },
    summary: 'A valance with a shallow V-shaped bottom edge.', warnings: [] });
  detailsReply = () => ({ summary: 'Plain valance with a V-shaped bottom; no interior details.', shapes: [], missing: [], warnings: [] });
  const r = await runAuto(page, 'tests/out/cabinets.jpg', '30', '4 3/4', 'valance');
  check('valance: automatic run finishes', !r.err, r.err || `${r.ms} ms`);
  const o = await page.evaluate(() => { const o = window.__editor.job.contours.outer; const ys = o.map((p) => p.y), xs = o.map((p) => p.x);
    // depth of the V: the outline's lowest point in the middle vs. at the ends
    const mid = o.filter((p) => Math.abs(p.x - 15) < 1).map((p) => p.y), end = o.filter((p) => p.x > 1 && p.x < 3).map((p) => p.y);
    return { n: o.length, w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), midBottom: Math.max(...mid), endBottom: Math.max(...end) }; });
  check('valance: traced the shaped outline (V bottom), not just a rectangle', o.n > 10 && Math.abs(o.w - 30) < 0.5 && o.midBottom - o.endBottom > 1.2, JSON.stringify(o));
  report.valance = { outline: o, ms: r.ms, dxf: await exportAndCheck(page, 'valance', 30, 4.75) };
  await page.context().close();
}

// ---- 4) the same valance picked from a build sheet, no key: the search stays inside the part's box
{
  const page = await newPage(false);
  calls.length = 0;
  const r = await runAuto(page, 'tests/out/cabinets.jpg', '30', '4 3/4', 'valance-nokey', () => {
    window.__editor.job.parent = { jobId: 'x', jobName: 'Smith kitchen', label: 'D1 Valance', description: 'Arched valance', box: { x0: 0.28, y0: 0.08, x1: 0.75, y1: 0.2 } };
  });
  check('build-sheet valance (no key): automatic run finishes without Claude', !r.err && calls.length === 0, r.err || `${r.ms} ms`);
  const o = await page.evaluate(() => { const o = window.__editor.job.contours.outer; const xs = o.map((p) => p.x), ys = o.map((p) => p.y);
    const mid = o.filter((p) => Math.abs(p.x - 15) < 1).map((p) => p.y), end = o.filter((p) => p.x > 1 && p.x < 3).map((p) => p.y);
    return { n: o.length, w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), midBottom: Math.max(...mid), endBottom: Math.max(...end) }; });
  check('build-sheet valance (no key): traced the valance in its box, not a cabinet', o.n > 10 && Math.abs(o.w - 30) < 0.5 && o.midBottom - o.endBottom > 1.2, JSON.stringify(o));
  report.valanceNoKey = { outline: o, ms: r.ms };
  await page.context().close();
}

check('no page errors', !errors.length, errors.join(' | '));
await browser.close();
fs.writeFileSync(`${OUT}/auto-report.json`, JSON.stringify(report, null, 1));
const failed = results.filter((x) => !x.ok);
console.log(`${results.length - failed.length}/${results.length} automatic-mode checks passed`);
process.exit(failed.length ? 1 : 0);
