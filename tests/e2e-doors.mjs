// End-to-end test of interior details on two door photos, in a phone-sized Chromium, driving the real UI.
// For each door: corners -> size -> outline -> Find details -> cut types -> mirror -> export (full + outline only).
// Then compares what was found with the true shapes and re-opens the DXFs. Also checks "Suggest details" with
// Claude's API simulated, tap-to-add, remove and layer hiding.
// Usage: node tests/e2e-doors.mjs http://localhost:8765/   (serve dist/ first)
import { createRequire } from 'module';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { checkDXF, segPoints } from '../src/core.js';
const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium, devices } = require('playwright');

const BASE = process.argv[2] || 'http://localhost:8765/';
const OUT = 'tests/e2e-out';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(ok ? 'PASS' : 'FAIL', name, detail); };
const report = {};

// mean and worst distance from points A to polyline B (closed or not), inches
function gap(A, B, closed = true) {
  const d = (p) => {
    let best = Infinity;
    const n = closed ? B.length : B.length - 1;
    for (let i = 0; i < n; i++) {
      const a = B[i], b = B[(i + 1) % B.length];
      const ab = [b[0] - a[0], b[1] - a[1]], l2 = ab[0] ** 2 + ab[1] ** 2 || 1;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2));
      best = Math.min(best, Math.hypot(p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t));
    }
    return best;
  };
  const ds = A.map(d);
  return { mean: ds.reduce((s, v) => s + v, 0) / ds.length, worst: Math.max(...ds) };
}
const bboxOf = (P) => { const xs = P.map((p) => p[0]), ys = P.map((p) => p[1]); return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }; };

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'], acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
let jobName = '';
page.on('dialog', (dg) => dg.accept(dg.type() === 'prompt' ? jobName : undefined));

// simulated Claude for "Suggest details"
const claudeCalls = [];
let claudeReply = null;
await page.route('https://api.anthropic.com/**', async (route) => {
  const req = route.request();
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  const body = JSON.parse(req.postData());
  claudeCalls.push({ url: req.url(), headers: req.headers(), body });
  const text = JSON.stringify(claudeReply(body));
  return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({
    id: 'msg_t', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }) });
});

async function tapImg(p) {
  const box = await page.locator('.stage-wrap canvas').first().boundingBox();
  const s = await page.evaluate((p) => window.__stage.toScr(p), p);
  await page.touchscreen.tap(box.x + s[0], box.y + s[1]);
  await page.waitForTimeout(150);
}
const ed = (fn, arg) => page.evaluate(fn, arg);

await page.goto(BASE);
await page.locator('#btn-settings').click();
await page.locator('input[type=password]').fill('sk-ant-test-key');
await page.getByRole('button', { name: 'Save settings' }).click();

for (const door of ['cathedral', 'glass']) {
  const truth = JSON.parse(fs.readFileSync(`tests/doors/${door}.json`, 'utf8'));
  jobName = door === 'cathedral' ? 'Cathedral door' : 'Glass door';
  const R = (report[door] = { found: [], dxf: {} });
  await page.getByRole('button', { name: /Shape → DXF/ }).click();
  await page.locator('input[type=file]:not([capture])').setInputFiles(`tests/doors/${door}.jpg`);
  await page.getByRole('button', { name: /do it by hand/ }).click(); // this test drives every manual tool
  await page.waitForSelector('.stage-wrap canvas');
  await page.waitForTimeout(400);
  const scale = await ed(() => window.__stage.imgW / 1800);
  for (const c of truth.door_corners_px) await tapImg([c[0] * scale, c[1] * scale]);
  await page.getByRole('button', { name: /Next: size/ }).click();
  await page.locator('.page input').nth(0).fill('15');
  await page.locator('.page input').nth(1).fill('28');
  await page.getByRole('button', { name: /Straighten photo/ }).click();
  await page.waitForSelector('.stage-wrap canvas');
  await page.waitForTimeout(300);
  // outline: tap inside the door near its edge (on the frame), auto-detect with "Find edges"
  await page.getByRole('button', { name: /Tap inside part/ }).click();
  await tapImg(await ed(() => window.__editor.px({ x: 1.2, y: 5 })));
  await page.getByRole('button', { name: /Auto-detect/ }).click();
  await page.waitForFunction(() => window.__editor.job.contours.outer.length > 10, null, { timeout: 60000 });
  await page.waitForTimeout(400);
  const outer = await ed(() => window.__editor.job.contours.outer.map((p) => [p.x, p.y]));
  const ob = bboxOf(outer);
  R.outline = { w: +ob.w.toFixed(3), h: +ob.h.toFixed(3) };
  check(`${door}: outline found`, Math.abs(ob.w - 15) < 0.25 && Math.abs(ob.h - 28) < 0.25, `${ob.w.toFixed(2)} x ${ob.h.toFixed(2)}`);
  await page.getByRole('button', { name: /Next: details/ }).click();
  await page.waitForTimeout(400);
  const t0 = Date.now();
  await page.getByRole('button', { name: /Find details/ }).click();
  await page.waitForFunction(() => !document.body.innerText.includes('Looking…'), null, { timeout: 60000 });
  R.findMs = Date.now() - t0;
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/d-${door}-1-found.png` });
  const feats = await ed(() => window.__editor.job.features.map((f) => ({ pts: f.pts.map((p) => [p.x, p.y]), closed: f.closed !== false, cut: f.cut, why: f.why })));
  // match each true feature to the closest found shape
  for (const t of truth.features) {
    let best = null;
    feats.forEach((f, i) => {
      const g1 = gap(t.pts, f.pts, f.closed), g2 = gap(f.pts, t.pts, t.closed);
      const score = (g1.mean + g2.mean) / 2;
      if (!best || score < best.score) best = { i, score, worst: Math.max(g1.worst, g2.worst), f };
    });
    const tb = bboxOf(t.pts);
    const row = { truth: t.what, expect: t.expect_cut, trueSize: `${tb.w.toFixed(2)} x ${tb.h.toFixed(2)}` };
    if (best && best.score < (t.expect_cut === 'skip' ? 1.0 : 0.5)) { // a field that isn't cut only needs to be roughly right
      const fb = bboxOf(best.f.pts);
      Object.assign(row, { found: `#${best.i + 1}`, foundSize: `${fb.w.toFixed(2)} x ${fb.h.toFixed(2)}`, meanGap: +best.score.toFixed(3), worstGap: +best.worst.toFixed(3), guessed: best.f.cut });
    } else Object.assign(row, { found: 'no', meanGap: best ? +best.score.toFixed(3) : null });
    R.found.push(row);
    check(`${door}: found ${t.what}`, row.found !== 'no', JSON.stringify(row));
    check(`${door}: guessed cut for ${t.what} = ${t.expect_cut}`, row.guessed === t.expect_cut, row.guessed || '');
  }
  R.extra = feats.length - R.found.filter((r) => r.found !== 'no').length;
  R.all = feats.map((f, i) => { const b = bboxOf(f.pts); return `#${i + 1} ${f.cut} ${f.closed ? 'shape' : 'line'} ${b.w.toFixed(2)}x${b.h.toFixed(2)}`; });

  // pick a shape on screen by tapping its line, then change its cut type with the big buttons
  const first = feats[0];
  await tapImg(await ed((q) => window.__editor.px({ x: q[0], y: q[1] }), first.pts[Math.floor(first.pts.length / 3)]));
  const picked = await ed(() => window.__editor.active);
  check(`${door}: tapping a shape picks it`, picked === 0, `active=${picked}`);

  if (door === 'cathedral') {
    // set the field to POCKET 1/4 and back to "not cut" to exercise the buttons and depth field
    const fieldIdx = feats.findIndex((f) => f.cut === 'skip');
    if (fieldIdx >= 0) {
      await page.locator('.feat-row').nth(fieldIdx).click();
      await page.getByRole('button', { name: 'POCKET', exact: true }).click();
      await page.locator('input[aria-label="Depth"]').fill('3/8');
      await page.locator('input[aria-label="Depth"]').dispatchEvent('change');
      const f = await ed((i) => window.__editor.job.features[i], fieldIdx);
      check('cathedral: cut button + depth field', f.cut === 'pocket' && Math.abs(f.depth - 0.375) < 1e-9, `${f.cut} ${f.depth}`);
      await page.getByRole('button', { name: 'NOT CUT', exact: true }).click();
    }
    // the raised-panel outline: profile with a raised-panel bit
    const profIdx = feats.findIndex((f) => f.cut === 'profile');
    if (profIdx >= 0) {
      await page.locator('.feat-row').nth(profIdx).click();
      await page.locator('select[aria-label="Bit"]').selectOption('rp_ogee');
      const f = await ed((i) => window.__editor.job.features[i], profIdx);
      check('cathedral: profile bit picked', f.bit === 'rp_ogee', f.bit);
    }
    // draw a decorative V-groove line by hand across the bottom rail
    await page.getByRole('button', { name: /Draw line/ }).click();
    for (const q of [{ x: 4, y: 26.5 }, { x: 7.5, y: 26.2 }, { x: 11, y: 26.5 }]) await tapImg(await ed((q) => window.__editor.px(q), q));
    await page.getByRole('button', { name: /Done drawing/ }).click();
    const g = await ed(() => window.__editor.job.features.at(-1));
    check('cathedral: hand-drawn groove line', g.closed === false && g.cut === 'groove' && g.pts.length === 3, `${g.cut} ${g.pts.length} pts`);
  } else {
    // tap-to-add: tap inside the glass. If it is already found, adding it again then removing it tests both.
    const n0 = await ed(() => window.__editor.job.features.length);
    await page.getByRole('button', { name: /Tap area/ }).click();
    await tapImg(await ed(() => window.__editor.px({ x: 7.5, y: 14 })));
    await page.waitForTimeout(500);
    const n1 = await ed(() => window.__editor.job.features.length);
    const added = n1 > n0 ? await ed(() => window.__editor.job.features.at(-1).pts.map((p) => [p.x, p.y])) : null;
    const gb = added ? bboxOf(added) : null;
    check('glass: tap inside an area adds it', !!added, gb ? `${gb.w.toFixed(2)} x ${gb.h.toFixed(2)}` : 'nothing added');
    if (added) {
      await page.getByRole('button', { name: /Remove shape/ }).click();
      check('glass: remove shape', (await ed(() => window.__editor.job.features.length)) === n0);
    }
    // "Suggest details" with a simulated Claude: it relabels shape #1 and adds a missing groove line
    claudeReply = (body) => ({
      summary: 'Shaker-style door with a glass lite and a V-groove around it.',
      shapes: [{ id: 1, cut: 'groove', depth_in: 0.125, bit: 'v90', description: 'Decorative V-groove loop', confidence: 'high' },
        { id: 2, cut: 'inside', depth_in: 0, bit: 'none', description: 'Glass opening', confidence: 'high' }],
      missing: [{ description: 'Small carved line', cut: 'groove', closed: false, depth_in: 0.1, bit: 'v60', points_in: [{ x: 5, y: 27.6 }, { x: 10, y: 27.6 }] }],
      warnings: ['Depths are guesses.'],
    });
    const nBefore = await ed(() => window.__editor.job.features.length);
    await page.getByRole('button', { name: /Suggest details/ }).click();
    await page.waitForFunction(() => !document.body.innerText.includes('Asking Claude…'), null, { timeout: 30000 });
    await page.waitForTimeout(300);
    const call = claudeCalls.at(-1);
    const img = call?.body.messages[0].content.find((c) => c.type === 'image');
    check('glass: Suggest details calls Claude Sonnet 5.5 with the photo and the numbered shapes', call && call.body.model === 'claude-sonnet-5-5' && img && /#1:/.test(call.body.messages[0].content.find((c) => c.type === 'text').text) && call.body.output_config?.format?.type === 'json_schema', call?.body.model);
    const after = await ed(() => window.__editor.job.features.map((f) => ({ cut: f.cut, bit: f.bit, depth: f.depth, src: f.src, n: f.pts.length })));
    check('glass: Claude’s answer is applied (relabel + missing line added)', after.length === nBefore + 1 && after.at(-1).cut === 'groove' && after.at(-1).bit === 'v60' && after.at(-1).src === 'claude', JSON.stringify(after.at(-1)));
    await page.screenshot({ path: `${OUT}/d-glass-2-claude.png` });
    // keep the test focused on what the photo detection found: drop Claude's extra line again
    await page.getByRole('button', { name: /Undo/ }).click();
  }
  await page.locator('.panel').screenshot({ path: `${OUT}/d-${door}-1b-panel.png` });

  // clean: mirror on, centerline found automatically
  await page.getByRole('button', { name: /Next: clean up/ }).click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: /Mirror: off/ }).click();
  await page.getByRole('button', { name: /Find center/ }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/d-${door}-2-clean.png` });
  const parts = await ed(() => window.__editor.shape.parts.map((p) => ({ cut: p.cut, closed: p.closed, n: p.segs.length, arcs: p.segs.filter((s) => s.type === 'arc').length })));
  R.cleanParts = parts;
  // how close the cleaned lines and arcs (what goes in the file) are to the true shapes
  const cleaned = await ed(() => window.__editor.shape.parts.map((p) => ({ cut: p.cut, segs: p.segs, closed: p.closed })));
  fs.writeFileSync(`${OUT}/d-${door}-features.json`, JSON.stringify(await ed(() => ({ features: window.__editor.job.features, outer: window.__editor.job.contours.outer, mirror: window.__editor.job.mirror }))));
  R.cleaned = [];
  for (const t of truth.features) {
    if (t.expect_cut === 'skip') continue;
    let best = null;
    for (const p of cleaned) {
      const pts = p.segs.flatMap((sg) => segPoints(sg, 0.05));
      const g1 = gap(t.pts, pts, false), g2 = gap(pts, t.pts, t.closed);
      const sc = Math.max(g1.mean, g2.mean);
      if (!best || sc < best.mean) best = { mean: sc, worst: Math.max(g1.worst, g2.worst), lines: p.segs.filter((x) => x.type === 'line').length, arcs: p.segs.filter((x) => x.type === 'arc').length };
    }
    R.cleaned.push({ truth: t.what, meanGap: +best.mean.toFixed(3), worstGap: +best.worst.toFixed(3), lines: best.lines, arcs: best.arcs });
    check(`${door}: cleaned ${t.what} within 1/16" on average, 3/16" worst`, best.mean <= 0.0625 && best.worst <= 0.19, JSON.stringify(R.cleaned.at(-1)));
  }

  // export: hide a layer on the preview, then download the full file and the outline-only file
  await page.getByRole('button', { name: /Next: export/ }).click();
  await page.waitForTimeout(500);
  const legendItems = page.locator('.legend-item');
  const nLegend = await legendItems.count();
  await legendItems.first().click();
  const hid = await ed(() => Object.keys(window.__editor.job.hiddenLayers));
  check(`${door}: legend hides a layer`, hid.length === 1, hid.join(','));
  await page.locator('.legend-item').first().click();
  await page.screenshot({ path: `${OUT}/d-${door}-3-export.png` });
  await page.locator('.page').screenshot({ path: `${OUT}/d-${door}-3-export-full.png` });
  const name = door + '-door';
  await page.locator('.page input:not([type=checkbox])').first().fill(name);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download DXF/ }).click()]);
  const full = `${OUT}/${dl.suggestedFilename()}`;
  await dl.saveAs(full);
  await page.locator('.page input[type=checkbox]').check();
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download DXF/ }).click()]);
  const only = `${OUT}/${dl2.suggestedFilename()}`;
  await dl2.saveAs(only);
  await page.locator('.page input[type=checkbox]').uncheck();
  const [dl3] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Save PNG/ }).click()]);
  await dl3.saveAs(`${OUT}/${dl3.suggestedFilename()}`);
  for (const [kind, file] of [['full', full], ['outline', only]]) {
    const chk = checkDXF(fs.readFileSync(file, 'utf8'));
    const ez = JSON.parse(execFileSync('python3', ['tests/verify_layers.py', file], { encoding: 'utf8' }));
    R.dxf[kind] = { file, layers: chk.layers, size: [+chk.width.toFixed(3), +chk.height.toFixed(3)], ok: chk.ok, problems: chk.problems, ezdxf: ez };
    check(`${door} ${kind} DXF: self-check ok, only lines/arcs, inches, 0,0`, chk.ok && chk.kinds.every((k) => k === 'LINE' || k === 'ARC') && chk.insunits === 1, chk.problems.join(' '));
    check(`${door} ${kind} DXF: ezdxf re-open (0 audit errors, closed where required)`, ez.audit_errors === 0 && ez.ok, JSON.stringify(ez.layers));
    check(`${door} ${kind} DXF: size 15 x 28 within 1/8"`, Math.abs(chk.width - 15) <= 0.125 && Math.abs(chk.height - 28) <= 0.125, `${chk.width.toFixed(3)} x ${chk.height.toFixed(3)}`);
  }
  check(`${door}: outline-only file has just the outline layer`, Object.keys(R.dxf.outline.layers).join() === 'OUTLINE', Object.keys(R.dxf.outline.layers).join());
  R.legendCount = nLegend;
  await page.goto(BASE);
  await page.waitForTimeout(400);
}
check('no page errors', !errors.length, errors.join(' | '));
await browser.close();
fs.writeFileSync(`${OUT}/doors-report.json`, JSON.stringify(report, null, 1));
const failed = results.filter((x) => !x.ok);
console.log(`${results.length - failed.length}/${results.length} door checks passed`);
process.exit(failed.length ? 1 : 0);
