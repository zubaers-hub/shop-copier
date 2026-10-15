// Mode 2: photo of a cabinet run -> Claude identifies the boxes -> editable list -> printable build sheet.
import { parseInches, formatInches } from './core.js';
import { loadPhoto, canvasToBlob } from './vision.js';
import { analyzeCabinets, CABINET_TYPES, DECOR_TYPES } from './claude.js';
import { saveJob, newId } from './store.js';
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
export function normalize(result) {
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
    };
  });
  return {
    summary: result.summary || '', scale_basis: result.scale_basis || '',
    style: { ...result.style }, cabinets: cabs,
    decor: (result.decorative_parts || []).map((p) => ({ id: newId(), kind: p.kind, description: p.description, location: p.location })),
    warnings: result.warnings || [],
  };
}

export function openCabinetJob(view, job, settings, { onOpenJob }) {
  const ctx = { view, job, settings, onOpenJob };
  const step = job.result ? (job.step === 'sheet' ? 'sheet' : 'edit') : 'photo';
  show(ctx, step);
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
      job.result = normalize(res);
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
      list.appendChild(el('div', { class: 'cab' },
        el('div', { class: 'cab-head' }, el('span', { class: 'num' }, `#${i + 1}`), type, upB, dnB, delB),
        c.confidence ? el('p', { class: 'small muted' }, `Claude’s confidence: ${c.confidence}` + (c.raw ? ` · raw estimate ${fmt(c.raw.w)} × ${fmt(c.raw.h)} × ${fmt(c.raw.d)}` : '')) : '',
        el('div', { class: 'dim3' }, dimInput('w', 'Width'), dimInput('h', 'Height'), dimInput('d', 'Depth')),
        el('div', { class: 'grid2' }, numInput('doors', 'Doors'), numInput('drawers', 'Drawers')),
        textInput('layout', 'Door / drawer layout'),
        textInput('hinge', 'Hinge side'),
        textInput('notes', 'Notes', true),
      ));
    });
  };
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
  const renderDecor = () => {
    decor.innerHTML = '';
    r.decor.forEach((p, i) => {
      const kind = el('select', {}, ...DECOR_TYPES.map((t) => el('option', { value: t }, DECOR_LABEL[t])));
      kind.value = p.kind;
      kind.onchange = () => { p.kind = kind.value; save(ctx); };
      const desc = el('input', { value: p.description || '' });
      desc.onchange = () => { p.description = desc.value; save(ctx); };
      const trace = el('button', { class: 'primary' }, '✏️ Trace in Shape → DXF');
      trace.onclick = async () => {
        const shapeJob = { id: newId(), kind: 'shape', name: `${job.name} – ${DECOR_LABEL[p.kind]}`, created: Date.now(), photo: job.photo, thumb: job.thumb, step: 'corners' };
        await saveJob(shapeJob);
        ctx.onOpenJob(shapeJob.id);
      };
      const del = el('button', { class: 'danger' }, '✕');
      del.onclick = () => { r.decor.splice(i, 1); save(ctx); renderDecor(); };
      decor.appendChild(el('div', { class: 'cab' }, el('div', { class: 'cab-head' }, kind, del), el('label', {}, 'Description / where'), desc, el('p', { class: 'small muted' }, p.location || ''), trace));
    });
    const add = el('button', {}, '+ Add decorative part');
    add.onclick = () => { r.decor.push({ id: newId(), kind: 'valance', description: '', location: '' }); save(ctx); renderDecor(); };
    decor.appendChild(add);
  };
  renderDecor();

  const name = el('input', { value: job.name || '' });
  name.onchange = () => { job.name = name.value; save(ctx); };
  const toSheet = el('button', { class: 'go' }, '📄 Make build sheet →');
  toSheet.onclick = () => show(ctx, 'sheet');

  page.append(
    el('label', {}, 'Job name'), name,
    r.summary ? el('p', {}, r.summary) : '',
    r.scale_basis ? el('p', { class: 'small muted' }, 'Scale: ' + r.scale_basis) : '',
    r.warnings.length ? el('div', { class: 'note' }, el('b', {}, 'Claude’s warnings: '), r.warnings.join(' · ')) : '',
    el('div', { class: 'note' }, 'Widths are rounded to 3" steps and heights/depths to standard sizes unless you entered them. Anything marked “estimate” came from the photo. Edit any field; it saves as you go.'),
    el('h2', {}, `Cabinets, left to right (${r.cabinets.length})`), list, addB,
    el('h2', {}, 'Style'), style,
    el('h2', {}, 'Decorative parts (Mode 1)'), decor,
    el('div', { style: 'margin-top:16px' }, toSheet),
  );
  ctx.view.appendChild(page);
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
    el('h3', {}, 'Cabinets, left to right'),
    el('table', {},
      el('thead', {}, el('tr', {}, ...['#', 'Type', 'W', 'H', 'D', 'Doors / drawers', 'Layout & notes'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...r.cabinets.map((c, i) => el('tr', {},
        el('td', {}, String(i + 1)),
        el('td', {}, TYPE_LABEL[c.type] || c.type),
        el('td', {}, f(c.w, c.est.w)), el('td', {}, f(c.h, c.est.h)), el('td', {}, f(c.d, c.est.d)),
        el('td', {}, `${c.doors || 0} door${c.doors === 1 ? '' : 's'}, ${c.drawers || 0} drawer${c.drawers === 1 ? '' : 's'}`),
        el('td', {}, [c.layout, c.hinge ? `Hinge: ${c.hinge}` : '', c.notes].filter(Boolean).join(' · '))))),
    ),
    el('p', {}, `Base/tall run width (sum of boxes): ${formatInches(totalW, d)}`),
    styleRows.length ? el('h3', {}, 'Style') : '',
    styleRows.length ? el('table', {}, el('tbody', {}, ...styleRows.map(([k, v]) => el('tr', {}, el('th', {}, k), el('td', {}, String(v).replace(/_/g, ' ')))))) : '',
    r.decor.length ? el('h3', {}, 'Decorative parts → trace these in Shape → DXF (Mode 1)') : '',
    r.decor.length ? el('ul', {}, ...r.decor.map((p) => el('li', {}, `${DECOR_LABEL[p.kind] || p.kind}: ${p.description || ''}${p.location ? ` (${p.location})` : ''}`))) : '',
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
