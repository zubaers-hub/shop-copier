// Small DOM helpers shared by the screens.

export const ACCURACY_NOTE = 'Sizes from a photo are estimates. Lens distortion, camera angle and parts that aren’t flat ' +
  'all add error. Entering one real measured edge (tape measure) makes everything else much more accurate.';

export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') e[k] = v;
    else if (k === 'value') e.value = v;
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid instanceof Node ? kid : String(kid));
  return e;
}

let toastT;
export function toast(msg, ms = 2600) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), ms);
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// Opens the phone's share sheet (AirDrop, email, Drive...) when the browser supports sharing files.
export async function shareFile(file, title) {
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title });
      return true;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return true;
  }
  return false;
}

export function safeFileName(s) {
  return String(s || 'file').trim().replace(/\.dxf$/i, '').replace(/[\\/:*?"<>|#%]+/g, '-').replace(/\s+/g, ' ').slice(0, 80) || 'file';
}

export function fmtDate(t) {
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
