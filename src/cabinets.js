// Mode 2: photo of a cabinet run -> Claude identifies the boxes -> editable list -> printable build sheet.
import { parseInches, formatInches } from './core.js';
import { loadPhoto, canvasToBlob } from './vision.js';
import { analyzeCabinets, CABINET_TYPES, DECOR_TYPES, FRONT_TYPES } from './claude.js';
import { saveJob, getJob, newId } from './store.js';
import { el, toast, ACCURACY_NOTE, fmtDate } from './ui.js';

const TYPE_LABEL = {
  base: 'Base', sink_base: 'Sink base', drawer_base: 'Drawer base', corner_base: 'Corner base', blind_corner_base: 'Blind corner base',
  wall: 'Wall', corner_wall: 'Corner wall', tall: 'Tall', pantry: 'Pantry', oven_tall: 'Oven tall', vanity: 'Vanity',
  open_shelf: 'Open shelf', appliance_opening: 'Appliance opening', filler: 'Filler', end_panel: 'End panel', other: 'Other',
};
const DECOR_LABEL = {
  valance: 'Valance', corbel: 'Corbel', bracket: 'Bracket', arched_door_top: 'Arched / cathedral door top',
  decorative_end_panel: 'Decorative end panel', applied_molding: 'Applied molding', cutout_pattern: 'Cutout pattern', other: 'Other',
};
const FRONT_LABEL = { door: 'Door', drawer: 'Drawer front', false_front: 'False front', open: 'Opening' };
const FRONT_SHORT = { door: 'Door', drawer: 'Drawer', false_front: 'False front', open: 'Opening' };
const FRONT_LETTER = (j) => String.fromCharCode(65 + (j % 26));
const KNOWN = [
  ['none', 'Nothing measured: use standard sizes'],
  ['run', 'Overall width of the run'],
  ['box', 'Width of one cabinet (#)'],
  ['baseh', 'Base cabinet box height (no top)'],
  ['counter', 'Floor to top of countertop'],
  ['wallh', 'Wall cabinet height'],
  ['other', 'Something else (describe)'],
];

const STD = {
  wallH: [12, 15, 18, 24, 30, 36, 39, 42],
  tallH: [84, 90, 93, 96],
};
const nearest = (v, list) => list.reduce((b, x) => (Math.abs(x - v) < Math.abs(b - v) ? x : b), list[0]);
const BASEISH = ['base', 'sink_base', 'drawer_base', 'corner_base', 'blind_corner_base'];
const TALLISH = ['tall', 'pantry', 'oven_tall'];
const WALLISH = ['wall', 'corner_wall'];

// Rounds Claude's estimates to standard sizes. Measured numbers are left alone.
// Claude's rectangle in the photo (fractions 0..1), checked; null if missing or nonsense
function photoBox(b) {
  if (!b) return null;
  const c = (v) => Math.min(1, Math.max(0, +v));
  const x0 = c(Math.min(b.left, b.right)), x1 = c(Math.max(b.left, b.right));
  const y0 = c(Math.min(b.top, b.bottom)), y1 = c(Math.max(b.top, b.bottom));
  if (![x0, x1, y0, y1].every(Number.isFinite) || x1 - x0 < 0.005 || y1 - y0 < 0.005) return null;
  return { x0, y0, x1, y1 };
}

export function normalize(result, photoAspect = 0) {
  const cabs = (result.cabinets || []).slice().sort((a, b) => a.position - b.position).map((c) => {
    const est = { w: !c.width_measured, h: !c.height_measured, d: !c.depth_measured };
    let w = c.width_in, h = c.height_in, d = c.depth_in;
    const t = c.type;
    const roughW = !['filler', 'end_panel', 'appliance_opening'].includes(t);
    if (est.w && w > 0) w = roughW ? Math.max(9, Math.round(w / 3) * 3) : Math.round(w * 4) / 4;
    if (est.h && h > 0) {
      if (BASEISH.includes(t)) h = 34.5;
      else if (t === 'vanity') h = nearest(h, [31.5, 34.5]);
      else if (WALLISH.includes(t)) h = nearest(h, STD.wallH);
      else if (TALLISH.includes(t)) h = nearest(h, STD.tallH);
      else h = Math.round(h * 4) / 4;
    }
    if (est.d && d > 0) {
      if (BASEISH.includes(t) || TALLISH.includes(t)) d = 24;
      else if (WALLISH.includes(t)) d = d > 18 ? 24 : 12;
      else if (t === 'vanity') d = 21;
      else d = Math.round(d * 4) / 4;
    }
    return {
      id: newId(), row: c.row, type: t, w, h, d, est,
      raw: { w: c.width_in, h: c.height_in, d: c.depth_in },
      doors: c.doors, drawers: c.drawers, layout: c.layout || '', hinge: c.hinge || '', notes: c.notes || '', confidence: c.confidence,
      box: photoBox(c.box_in_photo),
    };
  });
  // each door and drawer front: its size comes from where it sits in the photo, scaled by its cabinet's
  // (rounded) width so the fronts and the box agree; Claude's own estimate is the fallback
  (result.cabinets || []).slice().sort((a, b) => a.position - b.position).forEach((c, i) => {
    const cab = cabs[i];
    cab.fronts = (c.fronts || []).filter((f) => FRONT_TYPES.includes(f.kind)).map((f) => {
      const box = photoBox(f.box_in_photo);
      let w = f.width_in, h = f.height_in;
      if (box && cab.box && cab.w > 0 && photoAspect > 0) {
        const perIn = (cab.box.x1 - cab.box.x0) / cab.w; // photo widths per inch at this cabinet
        w = (box.x1 - box.x0) / perIn;
        h = ((box.y1 - box.y0) / photoAspect) / perIn;
      }
      const r16 = (v) => (v > 0 ? Math.round(v * 16) / 16 : 0);
      return { id: newId(), kind: f.kind, w: r16(w), h: r16(h), hinge: f.hinge || '', box };
    });
  });
  // a pair of doors or a stack of equal drawers is one size, not sizes a pixel apart
  const all = cabs.flatMap((c) => c.fronts);
  for (const key of ['w', 'h']) {
    const done = new Set();
    for (const f of all) {
      if (done.has(f) || !(f[key] > 0)) continue;
      const near = all.filter((g) => !done.has(g) && g.kind === f.kind && Math.abs(g[key] - f[key]) <= Math.max(0.25, f[key] * 0.03));
      const avg = Math.round((near.reduce((t, g) => t + g[key], 0) / near.length) * 16) / 16;
      near.forEach((g) => { g[key] = avg; done.add(g); });
    }
  }
  return {
    summary: result.summary || '', scale_basis: result.scale_basis || '',
    style: { ...result.style }, cabinets: cabs,
    decor: (result.decorative_parts || []).map((p) => ({ id: newId(), kind: p.kind, description: p.description, location: p.location, box: photoBox(p.box_in_photo) })),
    warnings: result.warnings || [],
  };
}

// focusDecor: id of a decorative part to scroll to (coming back from tracing it)
export function openCabinetJob(view, job, settings, { onOpenJob, focusDecor } = {}) {
  const ctx = { view, job, settings, onOpenJob, focusDecor };
  const step = focusDecor && job.result ? 'edit' : job.result ? (job.step === 'sheet' ? 'sheet' : 'edit') : 'photo';
  show(ctx, step);
}

// A close-up of one part of the photo: the part outlined, with some of what's around it for context.
// box: fractions of the photo (x0, y0, x1, y1). Returns a JPEG data URL, or null.
export async function partCrop(photoBlob, box, maxSide = 900) {
  if (!photoBlob || !box) return null;
  const img = await loadPhoto(photoBlob, 2400);
  const W = img.width, H = img.height;
  const bw = (box.x1 - box.x0) * W, bh = (box.y1 - box.y0) * H;
  const m = Math.max(0.35 * Math.max(bw, bh), 0.05 * Math.max(W, H));
  const sx = Math.max(0, box.x0 * W - m), sy = Math.max(0, box.y0 * H - m);
  const sw = Math.min(W, box.x1 * W + m) - sx, sh = Math.min(H, box.y1 * H + m) - sy;
  const k = Math.min(1, maxSide / Math.max(sw, sh)) * 1;
  const c = document.createElement('canvas');
  c.width = Math.round(sw * k); c.height = Math.round(sh * k);
  const g = c.getContext('2d');
  g.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  // dim everything but the part, then outline it
  const x = (box.x0 * W - sx) * k, y = (box.y0 * H - sy) * k, w = bw * k, h = bh * k;
  g.fillStyle = 'rgba(0,0,0,.35)';
  g.fillRect(0, 0, c.width, y); g.fillRect(0, y + h, c.width, c.height - y - h);
  g.fillRect(0, y, x, h); g.fillRect(x + w, y, c.width - x - w, h);
  const lw = Math.max(3, Math.round(c.width / 150));
  g.strokeStyle = DECOR_COLOR; g.lineWidth = lw; g.setLineDash([lw * 3, lw * 2]);
  g.strokeRect(x - lw / 2, y - lw / 2, w + lw, h + lw);
  return c.toDataURL('image/jpeg', 0.85);
}

function save(ctx) {
  clearTimeout(ctx.saveT);
  ctx.saveT = setTimeout(() => saveJob(ctx.job).catch((e) => toast('Could not save: ' + e.message)), 300);
}

function show(ctx, step) {
  ctx.job.step = step;
  save(ctx);
  ctx.view.innerHTML = '';
  const bar = el('nav', { class: 'steps no-print' });
  [['photo', 'Photo'], ['edit', 'Boxes'], ['sheet', 'Build sheet']].forEach(([id, label]) => {
    const b = el('button', { class: id === step ? 'current' : '' }, label);
    b.disabled = id !== 'photo' && !ctx.job.result;
    b.onclick = () => show(ctx, id);
    bar.appendChild(b);
  });
  ctx.view.appendChild(bar);
  ({ photo: stepPhoto, edit: stepEdit, sheet: stepSheet })[step](ctx);
}

// ---------------------------------------------------------------- photo + analyze
function stepPhoto(ctx) {
  const { job, settings } = ctx;
  job.known ||= { what: 'none', value: '', box: '', text: '' };
  const page = el('div', { class: 'page' });
  const cam = el('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  const pick = el('input', { type: 'file', accept: 'image/*', hidden: true });
  const take = el('button', { class: 'primary' }, '📷 Take photo');
  const up = el('button', {}, '🖼 Choose photo');
  const img = el('img', { class: 'preview-img', style: 'display:none;margin-top:10px' });
  take.onclick = () => cam.click();
  up.onclick = () => pick.click();
  const setImg = async () => {
    if (!job.photo) return;
    const url = URL.createObjectURL(job.photo);
    img.src = url; img.style.display = '';
  };
  const onFile = async (input) => {
    const f = input.files && input.files[0];
    if (!f) return;
    const c = await loadPhoto(f, 2400);
    job.photo = await canvasToBlob(c);
    job.thumb = thumb(c);
    save(ctx);
    setImg();
    check();
  };
  cam.onchange = () => onFile(cam);
  pick.onchange = () => onFile(pick);

  const what = el('select', {}, ...KNOWN.map(([v, l]) => el('option', { value: v }, l)));
  what.value = job.known.what;
  const value = el('input', { placeholder: 'inches, e.g. 34 1/2', value: job.known.value });
  const box = el('input', { type: 'number', min: 1, placeholder: 'Cabinet # from the left', value: job.known.box });
  const text = el('input', { placeholder: 'What did you measure?', value: job.known.text });
  const valueRow = el('div', {}, el('label', {}, 'Measurement'), value);
  const boxRow = el('div', {}, el('label', {}, 'Which cabinet (counting from the left)'), box);
  const textRow = el('div', {}, el('label', {}, 'Describe it'), text);
  const go = el('button', { class: 'go' }, '🤖 Identify cabinets with Claude');
  const status = el('div');
  const check = () => {
    job.known = { what: what.value, value: value.value, box: box.value, text: text.value };
    valueRow.style.display = what.value === 'none' ? 'none' : '';
    boxRow.style.display = what.value === 'box' ? '' : 'none';
    textRow.style.display = what.value === 'other' ? '' : 'none';
    const v = parseInches(value.value);
    const okKnown = what.value === 'none' || (v > 0 && (what.value !== 'box' || +box.value > 0) && (what.value !== 'other' || text.value.trim()));
    go.disabled = !job.photo || !okKnown;
    save(ctx);
  };
  what.onchange = value.oninput = box.oninput = text.oninput = check;

  go.onclick = async () => {
    if (!settings.apiKey) { toast('Add your Claude API key in Settings first (⚙ top right).', 4000); return; }
    go.disabled = true;
    status.innerHTML = '';
    status.append(el('div', { class: 'spinner' }), el('p', { class: 'muted', style: 'text-align:center' }, 'Claude is looking at the photo. This can take up to a minute…'));
    try {
      const c = await loadPhoto(job.photo, 1568);
      const b64 = c.toDataURL('image/jpeg', 0.85).split(',')[1];
      const res = await analyzeCabinets({ apiKey: settings.apiKey, model: settings.model, imageBase64: b64, known: knownText(job.known) });
      job.result = normalize(res, c.width / c.height);
      job.rawResult = res;
      if (!job.name || job.name.startsWith('Cabinet run')) job.name = `Cabinet run ${fmtDate(Date.now())}`;
      save(ctx);
      show(ctx, 'edit');
    } catch (e) {
      status.innerHTML = '';
      status.append(el('div', { class: 'bad-box' }, e.message || String(e)));
      go.disabled = false;
    }
  };

  page.append(
    el('h2', {}, 'Photo of the cabinets'),
    el('p', {}, 'Get the whole run in the shot, as straight-on as you can. One cabinet is fine too.'),
    el('div', { class: 'stack' }, take, up), cam, pick, img,
    el('h3', {}, 'Did you measure anything?'),
    el('p', { class: 'small muted' }, 'One real measurement makes every size better. Otherwise standard sizes set the scale: base 34 1/2" tall (36" to the counter), 24" deep; wall 12" deep.'),
    what, valueRow, boxRow, textRow,
    el('div', { class: 'note' }, ACCURACY_NOTE),
    go, status,
    settings.apiKey ? '' : el('p', { class: 'small' }, 'Needs a Claude API key (Settings ⚙). The photo is sent from this phone straight to Anthropic’s API.'),
  );
  ctx.view.appendChild(page);
  setImg();
  check();
}

function knownText(k) {
  const v = parseInches(k.value);
  if (k.what === 'none' || !(v > 0)) return '';
  const val = formatInches(v, 16);
  return {
    run: `the overall width of the whole run is ${val}`,
    box: `cabinet #${k.box} from the left is ${val} wide`,
    baseh: `the base cabinet box height (without countertop) is ${val}`,
    counter: `floor to the top of the countertop is ${val}`,
    wallh: `the wall cabinets are ${val} tall`,
    other: `${k.text}: ${val}`,
  }[k.what];
}

// ---------------------------------------------------------------- the photo with every found box drawn on it
const ROW_COLOR = { base: '#1e88e5', wall: '#2e9e44', tall: '#e85d04' };
const DECOR_COLOR = '#9c27b0';
const rowOf = (c) => (WALLISH.includes(c.type) ? 'wall' : TALLISH.includes(c.type) ? 'tall' : c.row === 'wall' || c.row === 'tall' ? c.row : 'base');

// onPick(kind, index): a box on the photo was tapped
function photoMap(ctx, { onPick, forPrint = false } = {}) {
  const { job } = ctx;
  const r = job.result;
  const wrap = el('div', { class: 'photo-map' });
  const canvas = el('canvas', { class: 'photo-map-canvas' });
  const legend = el('div', { class: 'map-legend' },
    ...[['base', 'Base'], ['wall', 'Wall'], ['tall', 'Tall']].map(([k, t]) => el('span', {}, el('span', { class: 'swatch', style: `background:${ROW_COLOR[k]}` }), t)),
    el('span', {}, el('span', { class: 'swatch', style: `background:${DECOR_COLOR}` }), 'Decorative (D1, D2…)'),
    r.cabinets.some((c) => c.fronts?.length) ? el('span', {}, el('span', { class: 'swatch front-swatch' }), 'Doors & drawers (1A, 1B…)') : '');
  const missing = r.cabinets.map((c, i) => (c.box ? null : i + 1)).filter(Boolean);
  const boxed = r.cabinets.length - missing.length;
  const note = el('p', { class: 'small' });
  if (!r.cabinets.some((c) => c.box) && !r.decor.some((p) => p.box)) {
    note.textContent = 'This run was analyzed before the app marked boxes on the photo. Analyze the photo again to see them.';
  } else {
    note.textContent = `Every box Claude found is outlined and numbered like the list${forPrint ? '' : ' (tap one to jump to it)'}${r.cabinets.some((c) => c.fronts?.length) ? ', and each door (dashed) and drawer front (solid) inside it is lettered 1A, 1B…' : ''}. A cabinet with no outline was missed: add it with “+ Add cabinet”. Two numbers on one cabinet means it was counted twice.`
      + (missing.length ? ` Not on the photo: #${missing.join(', #')} (added by hand or not placed).` : '');
  }
  const hits = [];
  (async () => {
    if (!job.photo) return;
    const img = await loadPhoto(job.photo, 1600);
    const W = img.width, H = img.height;
    canvas.width = W; canvas.height = H;
    const g = canvas.getContext('2d');
    g.drawImage(img, 0, 0);
    g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(0, 0, W, H);
    const lw = Math.max(3, Math.round(W / 300)), fs = Math.max(18, Math.round(W / 32));
    const draw = (b, color, label, dashed) => {
      const x = b.x0 * W, y = b.y0 * H, w = (b.x1 - b.x0) * W, h = (b.y1 - b.y0) * H;
      g.save();
      g.drawImage(img, x, y, w, h, x, y, w, h); // box area at full brightness
      g.strokeStyle = color; g.lineWidth = lw; g.setLineDash(dashed ? [lw * 3, lw * 2] : []);
      g.strokeRect(x + lw / 2, y + lw / 2, w - lw, h - lw);
      g.font = `900 ${fs}px system-ui, sans-serif`;
      const tw = g.measureText(label).width + fs * 0.6, th = fs * 1.3;
      const lx = x + w / 2 - tw / 2, ly = Math.min(Math.max(y + h / 2 - th / 2, 0), H - th);
      g.fillStyle = color; g.beginPath(); g.roundRect ? g.roundRect(lx, ly, tw, th, th / 3) : g.rect(lx, ly, tw, th); g.fill();
      g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(label, lx + tw / 2, ly + th / 2 + 1);
      g.restore();
    };
    r.cabinets.forEach((c, i) => { if (c.box) { draw(c.box, ROW_COLOR[rowOf(c)], String(i + 1), false); hits.push({ kind: 'cab', i, b: c.box }); } });
    // doors and drawer fronts: a thin white outline and a small tag (1A, 1B…) in each one's top-left corner
    const fsS = Math.max(12, Math.round(fs * 0.55)), lwS = Math.max(2, Math.round(lw * 0.6));
    r.cabinets.forEach((c, i) => (c.fronts || []).forEach((f, j) => {
      if (!f.box) return;
      const x = f.box.x0 * W, y = f.box.y0 * H, w = (f.box.x1 - f.box.x0) * W, h = (f.box.y1 - f.box.y0) * H;
      g.save();
      g.strokeStyle = '#fff'; g.lineWidth = lwS; g.setLineDash(f.kind === 'drawer' ? [] : [lwS * 3, lwS * 2]);
      g.strokeRect(x + lwS, y + lwS, w - 2 * lwS, h - 2 * lwS);
      const label = `${i + 1}${FRONT_LETTER(j)}`;
      g.font = `800 ${fsS}px system-ui, sans-serif`;
      const tw = g.measureText(label).width + fsS * 0.5, th = fsS * 1.25;
      g.fillStyle = ROW_COLOR[rowOf(c)]; g.fillRect(x + lwS * 2, y + lwS * 2, tw, th);
      g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(label, x + lwS * 2 + tw / 2, y + lwS * 2 + th / 2 + 1);
      g.restore();
      hits.push({ kind: 'front', i, j, b: f.box });
    }));
    r.decor.forEach((p, i) => { if (p.box) { draw(p.box, DECOR_COLOR, `D${i + 1}`, true); hits.push({ kind: 'decor', i, b: p.box }); } });
    if (forPrint) {
      // a printed sheet can't show a canvas reliably: swap in an image
      const im = el('img', { class: 'photo-map-canvas', alt: 'Photo with the found cabinets numbered', src: canvas.toDataURL('image/jpeg', 0.85) });
      canvas.replaceWith(im);
    }
  })().catch(() => { note.textContent = 'Couldn’t draw the photo.'; });
  if (onPick) {
    canvas.onclick = (e) => {
      const rc = canvas.getBoundingClientRect();
      const fx = (e.clientX - rc.left) / rc.width, fy = (e.clientY - rc.top) / rc.height;
      // smallest box under the tap (a wall cabinet can sit inside a tall one's rectangle)
      const under = hits.filter((h) => fx >= h.b.x0 && fx <= h.b.x1 && fy >= h.b.y0 && fy <= h.b.y1)
        .sort((a, b) => (a.b.x1 - a.b.x0) * (a.b.y1 - a.b.y0) - (b.b.x1 - b.b.x0) * (b.b.y1 - b.b.y0));
      if (under.length) onPick(under[0].kind, under[0].i, under[0].j);
    };
  }
  wrap.append(canvas, legend, note);
  wrap.dataset.boxed = String(boxed);
  return wrap;
}

// The doors and drawer fronts of one cabinet: kind and size of each, editable, each one a tap away from its DXF.
function frontsEditor(ctx, c, i, fmt, rerender) {
  const box = el('div', { class: 'fronts' });
  const fronts = c.fronts || (c.fronts = []);
  const sync = () => { c.doors = fronts.filter((f) => f.kind === 'door').length; c.drawers = fronts.filter((f) => f.kind === 'drawer').length; };
  box.append(el('label', {}, `Doors & drawer fronts (${fronts.length})`));
  if (!fronts.length) box.append(el('p', { class: 'small muted' }, 'None listed. Analyze the photo again to have Claude find them, or add them here.'));
  fronts.forEach((f, j) => {
    const kind = el('select', { 'aria-label': 'Front type' }, ...FRONT_TYPES.map((t) => el('option', { value: t }, FRONT_SHORT[t])));
    kind.value = f.kind;
    kind.onchange = () => { f.kind = kind.value; sync(); save(ctx); rerender(); };
    const dim = (key, label) => {
      const inp = el('input', { value: fmt(f[key]), inputmode: 'text', 'aria-label': `${label} ${i + 1}${FRONT_LETTER(j)}` });
      inp.onchange = () => { const v = parseInches(inp.value); if (v > 0) { f[key] = v; inp.value = fmt(v); save(ctx); } else { toast('Use inches like 15 3/4'); inp.value = fmt(f[key]); } };
      return inp;
    };
    const dxfB = el('button', { class: f.dxf ? '' : 'primary', title: 'Make this front’s DXF' }, f.dxf ? '✓ DXF' : '✨ DXF');
    dxfB.onclick = () => traceItem(ctx, f, `${i + 1}${FRONT_LETTER(j)} ${FRONT_LABEL[f.kind]}`, `${FRONT_LABEL[f.kind]} of cabinet #${i + 1}${f.hinge ? `, hinged ${f.hinge}` : ''}`, { w: f.w, h: f.h });
    const del = el('button', { class: 'danger', 'aria-label': 'Remove front' }, '✕');
    del.onclick = () => { fronts.splice(j, 1); sync(); save(ctx); rerender(); };
    box.append(el('div', { class: 'front-row', 'data-front': String(j) },
      el('b', { class: 'front-tag' }, `${i + 1}${FRONT_LETTER(j)}`), kind, dxfB, del,
      el('div', { class: 'front-dims' }, dim('w', 'Width'), el('span', {}, '×'), dim('h', 'Height'))));
  });
  const add = el('button', { class: 'linkish' }, '+ Add a door or drawer front');
  add.onclick = () => { fronts.push({ id: newId(), kind: 'drawer', w: c.w || 0, h: 6, hinge: '', box: null }); sync(); save(ctx); rerender(); };
  box.append(add);
  return box;
}

// ---------------------------------------------------------------- edit
function stepEdit(ctx) {
  const { job, settings } = ctx;
  const r = job.result;
  const d = settings.denom;
  const page = el('div', { class: 'page' });
  const list = el('div');
  const fmt = (v) => (v > 0 ? formatInches(v, d, '') : '');

  const render = () => {
    list.innerHTML = '';
    cards.length = 0;
    r.cabinets.forEach((c, i) => {
      const type = el('select', {}, ...CABINET_TYPES.map((t) => el('option', { value: t }, TYPE_LABEL[t] || t)));
      type.value = c.type;
      type.onchange = () => { c.type = type.value; save(ctx); };
      const dimInput = (key, label) => {
        const inp = el('input', { value: fmt(c[key]), inputmode: 'text', 'aria-label': label });
        const est = el('input', { type: 'checkbox' });
        est.checked = c.est[key];
        inp.onchange = () => {
          const v = parseInches(inp.value);
          if (v > 0) { c[key] = v; c.est[key] = false; est.checked = false; inp.value = fmt(v); save(ctx); } else { toast('Use inches like 23 1/4'); inp.value = fmt(c[key]); }
        };
        est.onchange = () => { c.est[key] = est.checked; save(ctx); };
        return el('div', {}, el('label', {}, label), inp, el('label', { class: 'check' }, est, 'estimate'));
      };
      const numInput = (key, label) => {
        const inp = el('input', { type: 'number', min: 0, value: c[key] ?? 0 });
        inp.onchange = () => { c[key] = Math.max(0, parseInt(inp.value || '0', 10)); save(ctx); };
        return el('div', {}, el('label', {}, label), inp);
      };
      const textInput = (key, label, ta = false) => {
        const inp = el(ta ? 'textarea' : 'input', { value: c[key] || '' });
        if (ta) inp.value = c[key] || '';
        inp.onchange = () => { c[key] = inp.value; save(ctx); };
        return el('div', {}, el('label', {}, label), inp);
      };
      const upB = el('button', { 'aria-label': 'Move left' }, '↑');
      const dnB = el('button', { 'aria-label': 'Move right' }, '↓');
      const delB = el('button', { class: 'danger', 'aria-label': 'Delete' }, '✕');
      upB.disabled = i === 0; dnB.disabled = i === r.cabinets.length - 1;
      upB.onclick = () => { [r.cabinets[i - 1], r.cabinets[i]] = [r.cabinets[i], r.cabinets[i - 1]]; save(ctx); render(); };
      dnB.onclick = () => { [r.cabinets[i + 1], r.cabinets[i]] = [r.cabinets[i], r.cabinets[i + 1]]; save(ctx); render(); };
      delB.onclick = () => { if (confirm(`Delete cabinet #${i + 1}?`)) { r.cabinets.splice(i, 1); save(ctx); render(); } };
      const card = el('div', { class: 'cab' },
        el('div', { class: 'cab-head' }, el('span', { class: 'num', style: `color:${c.box ? ROW_COLOR[rowOf(c)] : 'inherit'}` }, `#${i + 1}`), type, upB, dnB, delB),
        c.confidence ? el('p', { class: 'small muted' }, `Claude’s confidence: ${c.confidence}` + (c.raw ? ` · raw estimate ${fmt(c.raw.w)} × ${fmt(c.raw.h)} × ${fmt(c.raw.d)}` : '')) : '',
        el('div', { class: 'dim3' }, dimInput('w', 'Width'), dimInput('h', 'Height'), dimInput('d', 'Depth')),
        el('div', { class: 'grid2' }, numInput('doors', 'Doors'), numInput('drawers', 'Drawers')),
        frontsEditor(ctx, c, i, fmt, () => render()),
        textInput('layout', 'Door / drawer layout'),
        textInput('hinge', 'Hinge side'),
        textInput('notes', 'Notes', true),
      );
      cards.push(card);
      list.appendChild(card);
    });
    refreshMap();
  };
  const cards = [];
  const mapHolder = el('div');
  const flash = (node) => { if (!node) return; node.scrollIntoView({ behavior: 'smooth', block: 'center' }); node.classList.add('flash'); setTimeout(() => node.classList.remove('flash'), 1500); };
  const refreshMap = () => {
    mapHolder.innerHTML = '';
    mapHolder.append(photoMap(ctx, { onPick: (kind, i, j) => flash(kind === 'cab' ? cards[i] : kind === 'front' ? (cards[i]?.querySelector(`[data-front="${j}"]`) || cards[i]) : decorCards[i]) }));
  };
  const decorCards = [];
  render();

  const addB = el('button', {}, '+ Add cabinet');
  addB.onclick = () => {
    r.cabinets.push({ id: newId(), row: 'base', type: 'base', w: 24, h: 34.5, d: 24, est: { w: true, h: true, d: true }, doors: 1, drawers: 1, layout: '', hinge: '', notes: '' });
    save(ctx); render();
  };

  const styleFields = [
    ['door_style', 'Door style'], ['construction', 'Face frame / frameless'], ['door_overlay', 'Overlay'], ['toe_kick', 'Toe kick'],
    ['crown', 'Crown'], ['light_rail', 'Light rail'], ['fillers', 'Fillers'], ['end_panels', 'End panels'],
    ['countertop', 'Countertop'], ['hardware', 'Hardware'], ['finish', 'Finish'], ['other', 'Anything unusual'],
  ];
  const style = el('div', {}, ...styleFields.map(([k, label]) => {
    const inp = el('input', { value: (r.style[k] || '').replace(/_/g, ' ') });
    inp.onchange = () => { r.style[k] = inp.value; save(ctx); };
    return el('div', {}, el('label', {}, label), inp);
  }));

  const decor = el('div');
  const progress = el('div', { class: 'decor-progress' });
  const renderDecor = () => {
    decor.innerHTML = '';
    decorCards.length = 0;
    r.decor.forEach((p, i) => {
      const kind = el('select', {}, ...DECOR_TYPES.map((t) => el('option', { value: t }, DECOR_LABEL[t])));
      kind.value = p.kind;
      kind.onchange = () => { p.kind = kind.value; save(ctx); };
      const desc = el('input', { value: p.description || '' });
      desc.onchange = () => { p.description = desc.value; save(ctx); };
      const crop = el('img', { class: 'part-crop', alt: 'The part' });
      const cropBox = el('div', { class: 'part-crop-box' }, crop, el('p', { class: 'small muted' }, 'This is the part. Measure it, and the app does the rest: you just enter its width and height. A straight-on photo of just this part gives the best result.'));
      cropBox.style.display = 'none';
      if (p.box) partCrop(job.photo, p.box).then((u) => { if (u) { crop.src = u; cropBox.style.display = ''; } }).catch(() => {});
      const status = el('p', { class: 'small' });
      const trace = el('button', { class: 'primary' });
      if (p.dxf) {
        status.className = 'small ok-line';
        status.textContent = `✓ DXF made: ${p.dxf.file}` + (p.dxf.w ? ` (${formatInches(p.dxf.w, 16)} × ${formatInches(p.dxf.h, 16)})` : '');
        trace.className = '';
        trace.textContent = 'Open its DXF job';
      } else if (p.shapeJobId) {
        status.textContent = 'Started tracing, no DXF yet.';
        trace.textContent = '✨ Continue';
      } else {
        trace.textContent = '✨ Make its DXF (just enter the size)';
      }
      trace.onclick = () => traceDecor(ctx, p, i);
      const del = el('button', { class: 'danger' }, '✕');
      del.onclick = () => { r.decor.splice(i, 1); save(ctx); renderDecor(); refreshMap(); };
      const card = el('div', { class: 'cab', 'data-decor': p.id }, el('div', { class: 'cab-head' }, el('span', { class: 'num', style: `color:${DECOR_COLOR}` }, `D${i + 1}`), kind, del), cropBox, el('label', {}, 'Description / where'), desc, el('p', { class: 'small muted' }, p.location || ''), status, trace);
      decorCards.push(card);
      decor.appendChild(card);
    });
    // progress, and the next part to do
    const todo = r.decor.findIndex((p) => !p.dxf);
    progress.innerHTML = '';
    if (r.decor.length) {
      const done = r.decor.filter((p) => p.dxf).length;
      progress.append(el('p', {}, el('b', {}, `${done} of ${r.decor.length} done.`), done === r.decor.length ? ' All decorative parts have a DXF.' : ' Each one becomes its own DXF; you come back here when it’s done.'));
      if (todo >= 0) {
        const nextB = el('button', { class: 'go' }, `✨ Next: D${todo + 1} ${DECOR_LABEL[r.decor[todo].kind] || ''}`);
        nextB.onclick = () => traceDecor(ctx, r.decor[todo], todo);
        progress.append(nextB);
      }
    }
    const add = el('button', {}, '+ Add decorative part');
    add.onclick = () => { r.decor.push({ id: newId(), kind: 'valance', description: '', location: '' }); save(ctx); renderDecor(); };
    decor.appendChild(add);
  };
  renderDecor();

  const name = el('input', { value: job.name || '' });
  name.onchange = () => { job.name = name.value; save(ctx); };
  const toSheet = el('button', { class: 'go' }, '📄 Make build sheet →');
  toSheet.onclick = () => show(ctx, 'sheet');

  // the build sheet leads into tracing: say up front what's left to trace
  const left = r.decor.filter((p) => !p.dxf).length;
  let decorNote = '';
  if (left) {
    const jump = el('button', {}, `Go to them ↓`);
    jump.onclick = () => document.getElementById('decor-head')?.scrollIntoView({ behavior: 'smooth' });
    decorNote = el('div', { class: 'note decor-note' }, el('p', {}, `Claude flagged ${left} decorative part${left === 1 ? '' : 's'} that need a DXF (valance, corbel…). For each one you only enter its width and height; the app finds it in the photo, draws the shape and its details, and brings you back here.`), jump);
  }
  page.append(
    decorNote,
    el('label', {}, 'Job name'), name,
    r.summary ? el('p', {}, r.summary) : '',
    r.scale_basis ? el('p', { class: 'small muted' }, 'Scale: ' + r.scale_basis) : '',
    r.warnings.length ? el('div', { class: 'note' }, el('b', {}, 'Claude’s warnings: '), r.warnings.join(' · ')) : '',
    el('div', { class: 'note' }, 'Widths are rounded to 3" steps and heights/depths to standard sizes unless you entered them. Anything marked “estimate” came from the photo. Edit any field; it saves as you go.'),
    el('h2', {}, 'Check it on the photo'), mapHolder,
    el('h2', {}, `Cabinets, left to right (${r.cabinets.length})`), list, addB,
    el('h2', {}, 'Style'), style,
    el('h2', { id: 'decor-head' }, 'Decorative parts (DXF)'), progress, decor,
    el('div', { style: 'margin-top:16px' }, toSheet),
  );
  ctx.view.appendChild(page);
  // back from tracing a part: show where you were
  if (ctx.focusDecor) {
    const i = r.decor.findIndex((p) => p.id === ctx.focusDecor);
    // a door or drawer front: flash its row in its cabinet's card
    r.cabinets.forEach((c, ci) => (c.fronts || []).forEach((f, j) => {
      if (f.id !== ctx.focusDecor) return;
      const row = cards[ci]?.querySelector(`[data-front="${j}"]`);
      setTimeout(() => flash(row || cards[ci]), 150);
      if (f.dxf) toast(`${ci + 1}${FRONT_LETTER(j)} done.`, 3000);
    }));
    ctx.focusDecor = null;
    const card = decorCards[i];
    if (card) {
      setTimeout(() => flash(card), 150);
      if (r.decor[i].dxf) toast(`D${i + 1} done. ${r.decor.every((p) => p.dxf) ? 'All decorative parts have a DXF.' : 'Next one is below.'}`, 3500);
    }
  }
}

// Opens Shape → DXF for one decorative part: the part's close-up and description go with it, and the
// shape job knows to come back here when it's done.
async function traceDecor(ctx, p, i) {
  const label = `D${i + 1} ${DECOR_LABEL[p.kind] || p.kind}`;
  return traceItem(ctx, p, label, [p.description, p.location].filter(Boolean).join(' · '));
}

// Shared by decorative parts and fronts: a shape job with this photo, the item's close-up, and its size
// filled in when known, that comes back here when its DXF is saved.
async function traceItem(ctx, p, label, description, size = null) {
  const { job } = ctx;
  if (p.shapeJobId && (await getJob(p.shapeJobId))) { ctx.onOpenJob(p.shapeJobId); return; }
  const shapeJob = {
    id: newId(), kind: 'shape', name: `${job.name} – ${label}`, created: Date.now(), photo: job.photo, thumb: job.thumb, step: 'corners',
    parent: { jobId: job.id, jobName: job.name, decorId: p.id, label, description,
      box: p.box || null, crop: p.box ? await partCrop(job.photo, p.box).catch(() => null) : null },
  };
  if (size?.w > 0 && size?.h > 0) { shapeJob.realW = formatInches(size.w, 16, ''); shapeJob.realH = formatInches(size.h, 16, ''); }
  await saveJob(shapeJob);
  p.shapeJobId = shapeJob.id;
  clearTimeout(ctx.saveT);
  await saveJob(job);
  ctx.onOpenJob(shapeJob.id);
}

// Doors and drawer fronts as a cut list: one line per kind and size, with which cabinets they're on.
function frontsSheet(r, d) {
  const groups = new Map();
  r.cabinets.forEach((c, i) => (c.fronts || []).forEach((f, j) => {
    if (f.kind === 'open') return;
    const key = `${f.kind}|${formatInches(f.w, d)}|${formatInches(f.h, d)}`;
    if (!groups.has(key)) groups.set(key, { f, tags: [] });
    groups.get(key).tags.push(`${i + 1}${FRONT_LETTER(j)}${f.dxf ? ' ✓' : ''}`);
  }));
  if (!groups.size) return [];
  const rows = [...groups.values()].sort((a, b) => a.f.kind.localeCompare(b.f.kind) || b.f.h - a.f.h || b.f.w - a.f.w);
  return [
    el('h3', {}, 'Doors & drawer fronts (cut list)'),
    el('p', { class: 'small muted' }, 'Sizes are measured off the photo against each cabinet’s width (≈). Check overlay and reveals before cutting. ✓ = DXF made.'),
    el('table', {},
      el('thead', {}, el('tr', {}, ...['Qty', 'Part', 'W', 'H', 'On'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...rows.map(({ f, tags }) => el('tr', {},
        el('td', {}, String(tags.length)), el('td', {}, FRONT_LABEL[f.kind]),
        el('td', {}, '≈ ' + formatInches(f.w, d)), el('td', {}, '≈ ' + formatInches(f.h, d)), el('td', {}, tags.join(', ')))))),
  ];
}

// ---------------------------------------------------------------- printable sheet
function stepSheet(ctx) {
  const { job, settings } = ctx;
  const r = job.result;
  const d = settings.denom;
  const f = (v, e) => (v > 0 ? el('span', { class: e ? 'est-mark' : '' }, (e ? '≈ ' : '') + formatInches(v, d)) : '—');
  const page = el('div', { class: 'page sheet' });
  const printB = el('button', { class: 'primary no-print' }, '🖨 Print / save as PDF');
  printB.onclick = () => window.print();
  const totalW = r.cabinets.filter((c) => c.row !== 'wall' && !WALLISH.includes(c.type)).reduce((s, c) => s + (c.w || 0), 0);
  const style = r.style || {};
  const styleRows = [
    ['Door style', style.door_style], ['Construction', style.construction], ['Overlay', style.door_overlay], ['Toe kick', style.toe_kick],
    ['Crown', style.crown], ['Light rail', style.light_rail], ['Fillers', style.fillers], ['End panels', style.end_panels],
    ['Countertop', style.countertop], ['Hardware', style.hardware], ['Finish', style.finish], ['Other', style.other],
  ].filter(([, v]) => v && String(v).trim() && v !== 'unknown');
  page.append(
    el('div', { class: 'row no-print', style: 'margin-bottom:10px' }, printB),
    el('h2', {}, job.name || 'Cabinet build sheet'),
    el('p', {}, `Date: ${fmtDate(job.created || Date.now())}` + (r.scale_basis ? ` · Scale: ${r.scale_basis}` : '')),
    el('div', { class: 'note' }, '≈ marks a size estimated from the photo (rounded to standard sizes). ' + ACCURACY_NOTE),
    el('h3', {}, 'What was found in the photo'),
    photoMap(ctx, { forPrint: true }),
    el('h3', {}, 'Cabinets, left to right'),
    el('table', {},
      el('thead', {}, el('tr', {}, ...['#', 'Type', 'W', 'H', 'D', 'Doors / drawers', 'Layout & notes'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...r.cabinets.map((c, i) => el('tr', {},
        el('td', {}, el('b', { style: `color:${c.box ? ROW_COLOR[rowOf(c)] : 'inherit'}` }, String(i + 1))),
        el('td', {}, TYPE_LABEL[c.type] || c.type),
        el('td', {}, f(c.w, c.est.w)), el('td', {}, f(c.h, c.est.h)), el('td', {}, f(c.d, c.est.d)),
        el('td', {}, `${c.doors || 0} door${c.doors === 1 ? '' : 's'}, ${c.drawers || 0} drawer${c.drawers === 1 ? '' : 's'}`),
        el('td', {}, [c.layout, c.hinge ? `Hinge: ${c.hinge}` : '', c.notes].filter(Boolean).join(' · '))))),
    ),
    el('p', {}, `Base/tall run width (sum of boxes): ${formatInches(totalW, d)}`),
    ...frontsSheet(r, d),
    styleRows.length ? el('h3', {}, 'Style') : '',
    styleRows.length ? el('table', {}, el('tbody', {}, ...styleRows.map(([k, v]) => el('tr', {}, el('th', {}, k), el('td', {}, String(v).replace(/_/g, ' ')))))) : '',
    r.decor.length ? el('h3', {}, 'Decorative parts → DXF files') : '',
    r.decor.length ? el('ul', {}, ...r.decor.map((p, i) => el('li', {}, (p.dxf ? '✓ ' : '☐ ') + `D${i + 1} ${DECOR_LABEL[p.kind] || p.kind}: ${p.description || ''}${p.location ? ` (${p.location})` : ''}${p.dxf ? ` → ${p.dxf.file}` : ''}`))) : '',
    r.warnings.length ? el('h3', {}, 'Check on site') : '',
    r.warnings.length ? el('ul', {}, ...r.warnings.map((w) => el('li', {}, w))) : '',
  );
  ctx.view.appendChild(page);
}

function thumb(canvas) {
  const c = document.createElement('canvas');
  const k = 160 / Math.max(canvas.width, canvas.height);
  c.width = Math.round(canvas.width * k); c.height = Math.round(canvas.height * k);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
}
