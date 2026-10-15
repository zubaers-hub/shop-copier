// Jobs live in IndexedDB on this device (photos are too big for localStorage). Settings live in localStorage.

const DB_NAME = 'shop-copier';
const STORE = 'jobs';
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
    t.onerror = () => reject(t.error);
  }));
}

export const saveJob = (job) => tx('readwrite', (s) => s.put({ ...job, updated: Date.now() }));
export const getJob = (id) => tx('readonly', (s) => s.get(id));
export const deleteJob = (id) => tx('readwrite', (s) => s.delete(id));
export async function listJobs() {
  const all = await tx('readonly', (s) => s.getAll());
  return (all || []).sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

const SETTINGS_KEY = 'shop-copier-settings';
export const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'claude-opus-5-5',
  dxfVersion: 'R2000',
  layerOuter: 'OUTLINE',
  layerHole: 'CUTOUT',
  denom: 16,
};
export function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { return { ...DEFAULT_SETTINGS }; }
}
export function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* private mode: settings last for this visit */ }
}
