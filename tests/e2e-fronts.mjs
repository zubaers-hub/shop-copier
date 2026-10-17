// End-to-end test: the build sheet finds every door and drawer front (Claude simulated), sizes them off the
// photo against each cabinet's width, shows them on the photo, lists them as a cut list, and each one opens
// in Shape → DXF with its size already filled in.
// Photo: Momo's double vanity (2 doors | 3 drawers | 2 doors). Usage: node tests/e2e-fronts.mjs http://localhost:8765/
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium, devices } = require('playwright');

const BASE = process.argv[2] || 'http://localhost:8765/';
const OUT = 'tests/e2e-out';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(ok ? 'PASS' : 'FAIL', name, detail); };

// pixel rectangles on the 728 x 655 photo -> fractions, with a pixel or two of the wobble a real answer has
const W = 728, H = 655;
const bx = (l, t, r, b) => ({ left: l / W, top: t / H, right: r / W, bottom: b / H });
const front = (kind, l, t, r, b, hinge = '') => ({ kind, width_in: 0, height_in: 0, hinge, box_in_photo: bx(l, t, r, b) });
const cab = (position, type, width_in, l, r, fronts, doors, drawers, layout) => ({ position, row: 'base', type, width_in, height_in: 34.5, depth_in: 21,
  width_measured: false, height_measured: false, depth_measured: false, doors, drawers, layout, hinge: '', notes: '', confidence: 'medium',
  box_in_photo: bx(l, 206, r, 448), fronts });
const reply = {
  summary: 'A 72" double vanity: two door cabinets either side of a three-drawer bank.',
  scale_basis: 'Standard vanity sizes.',
  style: { door_style: 'Shaker', construction: 'frameless', door_overlay: 'full_overlay', toe_kick: 'furniture base', crown: '', light_rail: '', fillers: '', end_panels: '', countertop: 'quartz', hardware: 'black bar pulls', finish: 'white oak', other: '' },
  cabinets: [
    cab(1, 'vanity', 29, 72, 302, [front('door', 75, 208, 187, 446, 'left'), front('door', 189, 209, 301, 447, 'right')], 2, 0, '2 doors'),
    cab(2, 'vanity', 14.5, 305, 421, [front('drawer', 307, 208, 419, 284), front('drawer', 307, 288, 420, 366), front('drawer', 306, 370, 419, 446)], 0, 3, '3 drawers'),
    cab(3, 'vanity', 29, 425, 655, [front('door', 427, 208, 538, 446, 'left'), front('door', 540, 207, 653, 446, 'right')], 2, 0, '2 doors'),
  ],
  decorative_parts: [{ kind: 'other', description: 'Furniture-style base', location: 'below the cabinets', box_in_photo: bx(82, 452, 642, 477) }],
  warnings: [],
};
const msg = (text) => ({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Vanity' : undefined));
let sent = null;
await page.route('https://api.anthropic.com/**', async (route) => {
  const req = route.request();
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  sent = JSON.parse(req.postData());
  return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(msg(JSON.stringify(reply))) });
});
await page.goto(BASE);
await page.locator('#btn-settings').click();
await page.locator('input[type=password]').fill('sk-ant-test-key');
await page.getByRole('button', { name: 'Save settings' }).click();
await page.getByRole('button', { name: /Cabinet build sheet/ }).click();
await page.locator('input[type=file]:not([capture])').setInputFiles('tests/real/vanity.jpg');
await page.waitForTimeout(400);
await page.getByRole('button', { name: /Identify cabinets/ }).click();
await page.waitForFunction(() => /Cabinets, left to right/.test(document.body.innerText), null, { timeout: 30000 });

const schema = JSON.stringify(sent.output_config.format.schema), prompt = sent.messages[0].content.find((c) => c.type === 'text').text;
check('Claude is asked for every door and drawer front, with its own box on the photo', /"fronts"/.test(schema) && /"drawer"/.test(schema) && /each door and drawer front/.test(prompt));

const rows = await page.locator('.front-row').evaluateAll((els) => els.map((e) => ({
  tag: e.querySelector('.front-tag').textContent, kind: e.querySelector('select').value, w: e.querySelectorAll('input')[0].value, h: e.querySelectorAll('input')[1].value })));
check('Each cabinet card lists its fronts: 1A 1B doors, 2A–2C drawers, 3A 3B doors', rows.map((r) => r.tag + r.kind[0]).join(' ') === '1Ad 1Bd 2Ad 2Bd 2Cd 3Ad 3Bd'.replace(/2(.)d/g, '2$1d') && rows.filter((r) => r.kind === 'drawer').length === 3, JSON.stringify(rows));
const num = (v) => { const m = v.match(/^(\d+)(?: (\d+)\/(\d+))?$/); return m ? +m[1] + (m[2] ? m[2] / m[3] : 0) : NaN; };
const doors = rows.filter((r) => r.kind === 'door'), drawers = rows.filter((r) => r.kind === 'drawer');
// at 30" per cabinet (rounded), a door is ~112/230 of it = 14 5/8 wide and ~238 px tall = 31"; drawers ~15 x 10
check('Door sizes come off the photo against the cabinet width (~14 5/8 x ~31), pairs equal', doors.every((d) => Math.abs(num(d.w) - 14.6) < 0.5 && Math.abs(num(d.h) - 31) < 1) && new Set(doors.map((d) => d.w + d.h)).size === 1, JSON.stringify(doors));
check('Drawer fronts ~15 x ~10, all three the same size', drawers.every((d) => Math.abs(num(d.w) - 14.6) < 0.6 && Math.abs(num(d.h) - 9.9) < 0.6) && new Set(drawers.map((d) => d.w + d.h)).size === 1, JSON.stringify(drawers));

// the photo map: white outlines and 1A… tags drawn inside the cabinets
const map = await page.evaluate(() => {
  const c = document.querySelector('.photo-map-canvas'); const g = c.getContext('2d');
  const at = (fx, fy) => Array.from(g.getImageData(Math.round(fx * c.width), Math.round(fy * c.height), 1, 1).data);
  return { tagDrawer2: at(311 / 728, 293 / 655), legend: document.querySelector('.map-legend').innerText };
});
check('Photo map tags each front (2B drawn in the second drawer) and the legend names them', map.tagDrawer2[2] > 150 && map.tagDrawer2[0] < 120 && /Doors & drawers/.test(map.legend), JSON.stringify(map));
await page.locator('.photo-map').screenshot({ path: `${OUT}/f1-photo-map.png` });
// tap a drawer on the photo -> its row in the list flashes
const cv = await page.locator('.photo-map-canvas').boundingBox();
await page.mouse.click(cv.x + cv.width * (360 / 728), cv.y + cv.height * (405 / 655));
await page.waitForTimeout(200);
const flashed = await page.evaluate(() => document.querySelector('.front-row.flash .front-tag')?.textContent);
check('Tapping the bottom drawer on the photo jumps to 2C', flashed === '2C', flashed);
await page.locator('.cab').nth(1).screenshot({ path: `${OUT}/f2-card.png` });

// the build sheet: a cut list grouped by size
await page.getByRole('button', { name: /Make build sheet/ }).click();
await page.waitForTimeout(300);
const sheet = await page.locator('.sheet').innerText();
fs.writeFileSync(`${OUT}/f3-sheet.txt`, sheet);
check('Build sheet has a cut list: 4 doors, 3 drawer fronts', /Doors & drawer fronts \(cut list\)/.test(sheet) && /\n4\tDoor\t/.test(sheet) && /\n3\tDrawer front\t/.test(sheet) && /1A, 1B, 3A, 3B/.test(sheet), (sheet.match(/Qty[\s\S]{0,200}/) || [''])[0].replace(/\n/g, ' | '));
await page.locator('.sheet').screenshot({ path: `${OUT}/f3-sheet.png` });

// one front -> Shape → DXF with its size filled in
await page.locator('nav.steps button', { hasText: 'Boxes' }).click();
await page.waitForTimeout(300);
await page.locator('.front-row[data-front="1"]').nth(1).getByRole('button', { name: /DXF/ }).click();
await page.waitForSelector('.task-banner', { timeout: 15000 });
await page.waitForSelector('input[aria-label="Width"]', { timeout: 15000 });
const pre = { w: await page.locator('input[aria-label="Width"]').inputValue(), h: await page.locator('input[aria-label="Height"]').inputValue(), banner: await page.locator('.task-banner').innerText() };
check('A drawer front opens in Shape → DXF with its size already entered', num(pre.w) === num(drawers[1].w) && num(pre.h) === num(drawers[1].h) && /2B Drawer front/.test(pre.banner), JSON.stringify(pre).replace(/\\n/g, ' '));

check('no page errors', !errors.length, errors.join(' | '));
await browser.close();
const failed = results.filter((x) => !x.ok);
console.log(`${results.length - failed.length}/${results.length} door/drawer front checks passed`);
process.exit(failed.length ? 1 : 0);
