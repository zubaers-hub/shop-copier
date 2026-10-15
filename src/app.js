// App shell: job list, settings, routing between the two modes.
import { listJobs, getJob, saveJob, deleteJob, newId, loadSettings, saveSettings } from './store.js';
import { openShapeEditor } from './shape.js';
import { openCabinetJob } from './cabinets.js';
import { el, toast, fmtDate, ACCURACY_NOTE } from './ui.js';

const view = document.getElementById('view');
const title = document.getElementById('title');
let settings = loadSettings();
let current = null; // open editor (has destroy())

function setTitle(t) { title.textContent = t; document.title = t === 'Shop Copier' ? t : `${t} · Shop Copier`; }
function close() { if (current && current.destroy) current.destroy(); current = null; view.innerHTML = ''; }

async function home() {
  close();
  setTitle('Shop Copier');
  location.hash = '';
  const page = el('div', { class: 'page' });
  const newShape = el('button', { class: 'primary' }, 'Shape → DXF', el('span', {}, 'Arched tops, valances, corbels, brackets, end panels'));
  const newCab = el('button', { class: 'primary' }, 'Cabinet build sheet', el('span', {}, 'Photo of a run → box list for Mozaik'));
  newShape.onclick = () => createJob('shape');
  newCab.onclick = () => createJob('cabinets');
  page.append(el('div', { class: 'big-choice' }, newShape, newCab));
  page.append(el('h2', {}, 'Saved jobs'));
  const list = el('div', { class: 'cards' });
  page.append(list);
  view.appendChild(page);
  let jobs = [];
  try { jobs = await listJobs(); } catch (e) { list.append(el('div', { class: 'bad-box' }, 'This browser won’t let the app save jobs (private mode?). ' + e.message)); }
  if (!jobs.length) list.append(el('p', { class: 'muted' }, 'No jobs yet. Jobs save on this phone automatically.'));
  for (const j of jobs) {
    const open = el('button', {}, 'Open');
    const del = el('button', { class: 'danger', 'aria-label': 'Delete job' }, '🗑');
    open.onclick = () => openJob(j.id);
    del.onclick = async () => { if (confirm(`Delete “${j.name}”? This can’t be undone.`)) { await deleteJob(j.id); home(); } };
    list.append(el('div', { class: 'card' },
      j.thumb ? el('img', { src: j.thumb, alt: '' }) : el('img', { alt: '' }),
      el('div', { class: 'grow' },
        el('div', { class: 'name' }, j.name || 'Untitled'),
        el('div', { class: 'small muted' }, `${j.kind === 'shape' ? 'Shape → DXF' : 'Build sheet'} · ${fmtDate(j.updated || j.created)}`)),
      open, del));
  }
}

async function createJob(kind) {
  const name = prompt('Job name', kind === 'shape' ? `Shape ${fmtDate(Date.now())}` : `Cabinet run ${fmtDate(Date.now())}`);
  if (name === null) return;
  const job = { id: newId(), kind, name: name.trim() || 'Untitled', created: Date.now() };
  await saveJob(job);
  openJob(job.id);
}

async function openJob(id) {
  close();
  const job = await getJob(id);
  if (!job) { toast('Job not found'); home(); return; }
  location.hash = 'job=' + id;
  setTitle(job.name);
  if (job.kind === 'shape') current = await openShapeEditor(view, job, settings, { onTitle: setTitle });
  else current = openCabinetJob(view, job, settings, { onOpenJob: openJob });
}

function settingsPage() {
  close();
  setTitle('Settings');
  location.hash = 'settings';
  const s = settings;
  const page = el('div', { class: 'page' });
  const key = el('input', { type: 'password', value: s.apiKey, autocomplete: 'off', placeholder: 'sk-ant-…' });
  const show = el('button', {}, 'Show');
  show.onclick = () => { key.type = key.type === 'password' ? 'text' : 'password'; show.textContent = key.type === 'password' ? 'Show' : 'Hide'; };
  const model = el('select', {},
    el('option', { value: 'claude-opus-5-5' }, 'Claude Opus 5.5 (most accurate)'),
    el('option', { value: 'claude-sonnet-5-5' }, 'Claude Sonnet 5.5 (faster, cheaper)'));
  model.value = s.model;
  const ver = el('select', {}, el('option', { value: 'R2000' }, 'DXF 2000 (stores inches)'), el('option', { value: 'R12' }, 'DXF R12'));
  ver.value = s.dxfVersion;
  const lo = el('input', { value: s.layerOuter });
  const den = el('select', {}, el('option', { value: 8 }, '1/8"'), el('option', { value: 16 }, '1/16"'), el('option', { value: 32 }, '1/32"'));
  den.value = String(s.denom);
  const saveB = el('button', { class: 'go' }, 'Save settings');
  saveB.onclick = () => {
    settings = { ...s, apiKey: key.value.trim(), model: model.value, dxfVersion: ver.value,
      layerOuter: (lo.value.trim() || 'OUTLINE').replace(/[^A-Za-z0-9_\-$]/g, '_'),
      denom: +den.value };
    saveSettings(settings);
    toast('Saved on this device');
    home();
  };
  page.append(
    el('h2', {}, 'Claude (build sheets and “Suggest details”)'),
    el('label', {}, 'Anthropic API key'), el('div', { class: 'row' }, key, show),
    el('p', { class: 'small muted' }, 'Stored only on this device, in this browser. Photos go straight from this phone to Anthropic’s API. Get a key at console.anthropic.com.'),
    el('label', {}, 'Model for build sheets'), model,
    el('p', { class: 'small muted' }, '“Suggest details” in Shape → DXF always uses Claude Sonnet 5.5.'),
    el('h2', {}, 'DXF export'),
    el('label', {}, 'Default format'), ver,
    el('label', {}, 'Layer name for “outline only” files (Mozaik Part Editor)'), lo,
    el('p', { class: 'small muted' }, 'Full files use one layer per cut: OUTSIDE_CUT, INSIDE_CUT, POCKET_0.25, VGROOVE_90_0.125, PROFILE_EDGE_…'),
    el('label', {}, 'Round fractions to'), den,
    el('div', { style: 'margin-top:16px' }, saveB),
    el('div', { class: 'note' }, ACCURACY_NOTE),
  );
  view.appendChild(page);
}

document.getElementById('btn-home').onclick = home;
document.getElementById('btn-settings').onclick = settingsPage;

function route() {
  const h = location.hash.slice(1);
  if (h.startsWith('job=')) openJob(h.slice(4));
  else if (h === 'settings') settingsPage();
  else home();
}
route();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
