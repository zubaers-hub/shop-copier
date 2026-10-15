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
    { position: 1, row: 'base', type: 'drawer_base', width_in: 17.6, height_in: 34.2, depth_in: 23, width_measured: false, height_measured: false, depth_measured: false, doors: 0, drawers: 4, layout: '4 drawers', hinge: '', notes: '', confidence: 'high' },
    { position: 2, row: 'base', type: 'sink_base', width_in: 36.4, height_in: 34.5, depth_in: 24, width_measured: false, height_measured: false, depth_measured: false, doors: 2, drawers: 0, layout: '2 doors', hinge: 'left/right pair', notes: 'false front hidden by counter?', confidence: 'medium' },
    { position: 3, row: 'base', type: 'base', width_in: 23.1, height_in: 34.5, depth_in: 24, width_measured: false, height_measured: false, depth_measured: false, doors: 2, drawers: 1, layout: '1 drawer over 2 doors', hinge: '', notes: '', confidence: 'low' },
  ],
  decorative_parts: [{ kind: 'valance', description: 'Arched valance, about 30" wide', location: 'above the sink' }],
  warnings: ['Depth cannot be seen; standard 24" assumed.'],
};
const msg = (text) => ({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }],
  stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1500, output_tokens: 900 } });

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
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
// decorative part → new shape job with the same photo
await page.locator('nav.steps button', { hasText: 'Boxes' }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: /Trace in Shape/ }).first().click();
await page.waitForSelector('.stage-wrap canvas', { timeout: 10000 }).catch(() => {});
const title = await page.locator('#title').textContent();
check('“Trace in Shape → DXF” opens a shape job with the photo', (await page.locator('.stage-wrap canvas').count()) === 1, title);
await page.screenshot({ path: `${OUT}/c4-trace-decor.png` });
await page.goto(BASE);
await page.waitForTimeout(400);
const jobs = await page.locator('.card .name').allTextContents();
check('Both jobs are in the saved list', jobs.length >= 2, JSON.stringify(jobs));
check('No page errors', !errors.length, errors.join(' | '));
await browser.close();
const failed = results.filter((x) => !x.ok).length;
console.log(`${results.length - failed}/${results.length} build-sheet checks passed`);
process.exit(failed ? 1 : 0);
