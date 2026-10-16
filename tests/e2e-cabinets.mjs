// End-to-end test of the cabinet build sheet in a phone-sized Chromium, with Claude's API simulated
// (no real key here). Checks what the app sends to Claude, how it handles the reply, errors, and the sheet.
// Usage: node tests/e2e-cabinets.mjs http://localhost:8765/
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium, devices } = require('playwright');

const BASE = process.argv[2] || 'http://localhost:8765/';
const OUT = 'tests/e2e-out';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(ok ? 'PASS' : 'FAIL', name, detail); };

const reply = {
  summary: 'Three base cabinets under a countertop, with an arched valance above.',
  scale_basis: 'Overall run width of 78" given by the user.',
  style: { door_style: 'Shaker', construction: 'face_frame', door_overlay: 'partial_overlay', toe_kick: '4" recessed', crown: 'none visible',
    light_rail: 'none', fillers: 'none visible', end_panels: 'none', countertop: 'laminate, 1 1/2" edge', hardware: 'none visible', finish: 'white paint', other: '' },
  cabinets: [
    { position: 1, row: 'base', type: 'drawer_base', width_in: 17.6, height_in: 34.2, depth_in: 23, width_measured: false, height_measured: false, depth_measured: false, doors: 0, drawers: 4, layout: '4 drawers', hinge: '', notes: '', confidence: 'high', box_in_photo: { left: 0.063, top: 0.5, right: 0.288, bottom: 0.9 } },
    { position: 2, row: 'base', type: 'sink_base', width_in: 36.4, height_in: 34.5, depth_in: 24, width_measured: false, height_measured: false, depth_measured: false, doors: 2, drawers: 0, layout: '2 doors', hinge: 'left/right pair', notes: 'false front hidden by counter?', confidence: 'medium', box_in_photo: { left: 0.288, top: 0.5, right: 0.738, bottom: 0.9 } },
    { position: 3, row: 'base', type: 'base', width_in: 23.1, height_in: 34.5, depth_in: 24, width_measured: false, height_measured: false, depth_measured: false, doors: 2, drawers: 1, layout: '1 drawer over 2 doors', hinge: '', notes: '', confidence: 'low', box_in_photo: { left: 0.738, top: 0.5, right: 1.0, bottom: 0.9 } },
  ],
  decorative_parts: [{ kind: 'valance', description: 'Arched valance, about 30" wide', location: 'above the sink', box_in_photo: { left: 0.28, top: 0.08, right: 0.75, bottom: 0.2 } }],
  warnings: ['Depth cannot be seen; standard 24" assumed.'],
};
const msg = (text) => ({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }],
  stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1500, output_tokens: 900 } });

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'], acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Smith kitchen' : undefined));

let mode = 'ok';
const seen = [];
await page.route('https://api.anthropic.com/**', async (route) => {
  const req = route.request();
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
  const body = JSON.parse(req.postData());
  seen.push({ url: req.url(), headers: req.headers(), body });
  const cors = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
  const err = (status, type, message) => route.fulfill({ status, headers: cors, body: JSON.stringify({ type: 'error', error: { type, message } }) });
  if (mode === 'auth') return err(401, 'authentication_error', 'invalid x-api-key');
  if (mode === 'nobeta' && /beta=true/.test(req.url())) return err(400, 'invalid_request_error', 'Unsupported beta header: server-side-fallback-2026-07-01');
  if (mode === 'refusal') return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ ...msg(''), stop_reason: 'refusal' }) });
  return route.fulfill({ status: 200, headers: cors, body: JSON.stringify(msg(JSON.stringify(reply))) });
});

await page.goto(BASE);
// settings: enter the key once
await page.locator('#btn-settings').click();
await page.locator('input[type=password]').fill('sk-ant-test-key');
await page.getByRole('button', { name: 'Save settings' }).click();
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('shop-copier-settings')));
check('API key saved on the device', stored.apiKey === 'sk-ant-test-key');

await page.getByRole('button', { name: /Cabinet build sheet/ }).click();
await page.locator('input[type=file]:not([capture])').setInputFiles('tests/out/cabinets.jpg');
await page.waitForTimeout(400);
await page.locator('select').first().selectOption('run');
await page.locator('input[placeholder^="inches"]').fill('78');
await page.screenshot({ path: `${OUT}/c1-photo.png` });

async function identify() {
  await page.getByRole('button', { name: /Identify cabinets/ }).click();
  await page.waitForFunction(() => document.querySelector('.bad-box') || /Cabinets, left to right/.test(document.body.innerText), null, { timeout: 30000 });
}
// 1) a bad key gives a plain-English message
mode = 'auth';
await identify();
const authMsg = await page.locator('.bad-box').textContent().catch(() => '');
check('Rejected key shows a clear message', /API key was rejected/.test(authMsg), authMsg);
// 2) a refusal is reported, not shown as empty results
mode = 'refusal';
await identify();
const refMsg = await page.locator('.bad-box').textContent().catch(() => '');
check('Refusal is reported', /declined/.test(refMsg), refMsg);
// 3) account without the fallback beta: retries without it
mode = 'nobeta';
seen.length = 0;
await identify();
check('Works when the fallback beta is not available (retries plainly)', seen.length === 2 && !/beta=true/.test(seen[1].url) && (await page.locator('text=Cabinets, left to right').count()) === 1, seen.map((s) => s.url).join(' , '));
// the request itself
const r = seen[0];
const img = r.body.messages[0].content.find((c) => c.type === 'image');
check('Request: key header, browser access header, model', r.headers['x-api-key'] === 'sk-ant-test-key' && r.headers['anthropic-dangerous-direct-browser-access'] === 'true' && r.body.model === 'claude-opus-5-5', `model=${r.body.model}`);
check('Request: structured JSON output + fallback beta', r.body.output_config?.format?.type === 'json_schema' && /server-side-fallback/.test(r.headers['anthropic-beta'] || ''), r.headers['anthropic-beta']);
check('Request: photo sent as JPEG, max 1568 px', img && img.source.media_type === 'image/jpeg' && img.source.data.length > 10000);
check('Request: the measurement is in the prompt', /78/.test(r.body.messages[0].content.find((c) => c.type === 'text').text));
const schemaText = JSON.stringify(r.body.output_config?.format?.schema || r.body);
check('Request: asks where each cabinet and decorative part is in the photo', (schemaText.match(/box_in_photo/g) || []).length >= 2 && /box_in_photo/.test(r.body.messages[0].content.find((c) => c.type === 'text').text));
// the photo with numbered boxes, to check nothing was missed
await page.waitForTimeout(800);
const map = await page.evaluate(() => {
  const c = document.querySelector('.photo-map-canvas');
  if (!c || !c.width) return null;
  const g = c.getContext('2d');
  // outline colors just inside each box's edge: base blue for the cabinets, purple for the valance
  const at = (fx, fy, dx = 0, dy = 0) => Array.from(g.getImageData(Math.round(fx * c.width) + dx, Math.round(fy * c.height) + dy, 1, 1).data.slice(0, 3));
  return { w: c.width, h: c.height, cab2: at(0.738, 0.6, -3), valance: at(0.4, 0.08, 0, 3), note: document.querySelector('.photo-map p').textContent };
});
const near = (a, b) => a && a.every((v, i) => Math.abs(v - b[i]) < 60);
check('Boxes step shows the photo with the cabinets numbered on it', map && map.w > 500 && near(map.cab2, [0x1e, 0x88, 0xe5]) && map.valance[0] > map.valance[1] + 30 && map.valance[2] > map.valance[1] + 40, JSON.stringify(map));
// tapping a box on the photo jumps to that cabinet in the list
const cv = await page.locator('.photo-map-canvas').boundingBox();
await page.touchscreen.tap(cv.x + cv.width * 0.85, cv.y + cv.height * 0.7);
await page.waitForTimeout(300);
const flashed = await page.evaluate(() => [...document.querySelectorAll('.cab')].findIndex((e) => e.classList.contains('flash')));
check('Tapping cabinet 3 on the photo jumps to #3 in the list', flashed === 2, `flashed index ${flashed}`);
await page.locator('.photo-map').screenshot({ path: `${OUT}/c2b-photo-map.png` });
await page.screenshot({ path: `${OUT}/c2-edit.png`, fullPage: true });

// edit screen: rounded widths, est flags, editing
const widths = await page.locator('input[aria-label="Width"]').evaluateAll((els) => els.map((e) => e.value));
check('Widths rounded to 3" steps', JSON.stringify(widths) === JSON.stringify(['18', '36', '24']), JSON.stringify(widths));
await page.locator('input[aria-label="Width"]').nth(2).fill('22 1/2');
await page.locator('input[aria-label="Width"]').nth(2).dispatchEvent('change');
await page.getByRole('button', { name: /Make build sheet/ }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/c3-sheet.png`, fullPage: true });
const sheet = await page.locator('.sheet').innerText();
fs.writeFileSync(`${OUT}/c3-sheet.txt`, sheet);
check('Sheet keeps the hand-edited width', /22 1\/2/.test(sheet));
check('Sheet marks estimates with ≈', /≈/.test(sheet));
check('Sheet flags the valance for Shape → DXF', /valance/i.test(sheet) && /Shape → DXF|DXF/.test(sheet));
check('Sheet shows the style', /Shaker/.test(sheet));
check('Sheet includes the numbered photo', await page.locator('.sheet img.photo-map-canvas').count() === 1 && /What was found in the photo/.test(sheet));
// decorative part → new shape job with the same photo
await page.locator('nav.steps button', { hasText: 'Boxes' }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: /Trace in Shape/ }).first().click();
await page.waitForSelector('.stage-wrap canvas', { timeout: 10000 }).catch(() => {});
const title = await page.locator('#title').textContent();
check('“Trace in Shape → DXF” opens a shape job with the photo', (await page.locator('.stage-wrap canvas').count()) === 1, title);
// the part to trace goes with it: a close-up, its name and description, and the way back
const banner = await page.locator('.task-banner').innerText().catch(() => '');
const cropOk = await page.locator('.task-banner img.task-crop').evaluate((im) => im.naturalWidth > 100).catch(() => false);
check('Shape job shows what to trace (close-up, D1 valance, description) and a way back', /Tracing D1 Valance/.test(banner) && /Arched valance/.test(banner) && /Smith kitchen/.test(banner) && cropOk, banner.replace(/\n/g, ' | '));
const zoom = await page.evaluate(() => { const st = window.__stage, w = st.imgW; const a = st.toScr([0.28 * w, 0]), b = st.toScr([0.75 * w, 0]); return { a: a[0], b: b[0], cw: st.cssW }; });
check('Corner step starts zoomed on the part, outlined', zoom.a > 0 && zoom.b < zoom.cw && zoom.b - zoom.a > zoom.cw * 0.4, JSON.stringify(zoom));
await page.screenshot({ path: `${OUT}/c4-trace-decor.png` });
// trace it: the valance's top rectangle as reference (30" wide), outline set by hand, export
const tapPhoto = async (fx, fy) => {
  const box = await page.locator('.stage-wrap canvas').first().boundingBox();
  const sp = await page.evaluate(([fx, fy]) => window.__stage.toScr([fx * window.__stage.imgW, fy * window.__stage.imgH]), [fx, fy]);
  await page.touchscreen.tap(box.x + sp[0], box.y + sp[1]);
  await page.waitForTimeout(120);
};
await page.evaluate(() => { const st = window.__stage; st.fit({ x: 0.25 * st.imgW, y: 0.04 * st.imgH, w: 0.53 * st.imgW, h: 0.2 * st.imgH }); }); // like pinching in
for (const [fx, fy] of [[0.2813, 0.08], [0.75, 0.08], [0.75, 0.2], [0.2813, 0.2]]) await tapPhoto(fx, fy);
await page.getByRole('button', { name: /Next: size/ }).click();
await page.locator('.page input').nth(0).fill('30');
await page.locator('.page input').nth(1).fill('7.5');
await page.getByRole('button', { name: /Straighten photo/ }).click();
await page.waitForSelector('.stage-wrap canvas');
await page.evaluate(() => {
  const e = window.__editor;
  e.job.contours.outer = [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 5 }, { x: 22.5, y: 5 }, { x: 15, y: 7.5 }, { x: 7.5, y: 5 }, { x: 0, y: 5 }].map((p) => ({ ...p, corner: true }));
  e.changed();
});
await page.getByRole('button', { name: /Next: details/ }).click();
await page.getByRole('button', { name: /Next: clean up/ }).click();
await page.getByRole('button', { name: /Next: export/ }).click();
await page.waitForTimeout(400);
const doneHidden = await page.locator('.ok-box:has-text("ticked off")').isHidden();
const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download DXF/ }).click()]);
await page.waitForTimeout(500);
check('After the DXF is saved, “Done, back to Smith kitchen” appears', doneHidden && await page.locator('.ok-box:has-text("ticked off")').isVisible(), dl.suggestedFilename());
await page.locator('.ok-box').getByRole('button', { name: /back to Smith kitchen/ }).click();
await page.waitForSelector('.decor-progress');
await page.waitForTimeout(800);
const back = await page.evaluate(() => ({ title: document.querySelector('#title').textContent, step: document.querySelector('nav.steps .current')?.textContent,
  flashed: !!document.querySelector('.cab.flash[data-decor]'), progress: document.querySelector('.decor-progress').innerText, card: document.querySelector('.cab[data-decor]').innerText }));
check('Back lands on the build sheet’s Boxes step at D1, ticked off', back.title === 'Smith kitchen' && back.step === 'Boxes' && back.flashed && /1 of 1 traced/.test(back.progress) && /DXF made: .*\.dxf/.test(back.card), JSON.stringify(back).slice(0, 300));
await page.screenshot({ path: `${OUT}/c5-back-from-trace.png` });
await page.locator('nav.steps button', { hasText: 'Build sheet' }).click();
await page.waitForTimeout(300);
check('Build sheet lists the valance as done with its DXF', /✓ D1 Valance.*\.dxf/.test(await page.locator('.sheet').innerText()));
// opening it again goes to the same shape job, not a new one
await page.locator('nav.steps button', { hasText: 'Boxes' }).click();
await page.getByRole('button', { name: /Open the traced shape/ }).click();
await page.waitForSelector('.task-banner');
check('“Open the traced shape” reopens the same job', /Tracing D1/.test(await page.locator('.task-banner').innerText()));
await page.goto(BASE);
await page.waitForTimeout(400);
const jobs = await page.locator('.card .name').allTextContents();
check('Both jobs are in the saved list (one shape job, not two)', jobs.length === 2, JSON.stringify(jobs));
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();
const failed = results.filter((x) => !x.ok).length;
console.log(`${results.length - failed}/${results.length} build-sheet checks passed`);
process.exit(failed ? 1 : 0);
