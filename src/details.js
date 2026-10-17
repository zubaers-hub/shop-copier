// Finds the details inside a part's outline (panel edges, arches, cutouts, grooves, carved lines) on the
// straightened photo, and guesses how each is cut. Pure OpenCV.js + math, no DOM, so tests can run it in Node.
//
//   findDetails(cv, rgba, outer, ppi, { sensitivity, minSize })
//     rgba: cv.Mat (CV_8UC4) of the straightened photo; outer: outline in its pixels [[x,y]...]; ppi: pixels per inch
//     sensitivity 1..10 (higher finds fainter edges); minSize: smallest feature to keep, in inches
//   -> { shapes: [{ pts: [[x,y]...] px, closed, guess: { cut, why }, size: { w, h } in inches, score }], edges }
//
//   regionAt(cv, found, point) -> the closed region around a tapped point, using the edge map from findDetails.

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function contourPts(c) {
  const d = c.data32S, out = [];
  for (let i = 0; i < d.length; i += 2) out.push([d[i], d[i + 1]]);
  return out;
}

function polyArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1]; }
  return Math.abs(a) / 2;
}
function polyLen(p, closed = true) {
  let s = 0;
  for (let i = 1; i < p.length; i++) s += dist(p[i - 1], p[i]);
  return closed && p.length > 2 ? s + dist(p[p.length - 1], p[0]) : s;
}
function bbox(p) {
  const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}
export function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// percentile of the non-zero-mask pixels of a single-channel float/uchar Mat
function percentile(cv, mat, mask, q) {
  const hist = new Array(1024).fill(0);
  const d = mat.data32F || mat.data, m = mask.data;
  let n = 0, max = 0;
  for (let i = 0; i < m.length; i++) if (m[i]) { const v = d[i]; if (v > max) max = v; }
  if (!max) return 0;
  for (let i = 0; i < m.length; i++) if (m[i]) { hist[Math.min(1023, Math.floor((d[i] / max) * 1023))]++; n++; }
  let acc = 0;
  for (let k = 0; k < 1024; k++) { acc += hist[k]; if (acc >= q * n) return (k / 1023) * max; }
  return max;
}


// Centerline of a thin blob: split its outline at the two points farthest apart and average the two sides.
function centerline(outline) {
  const n = outline.length;
  if (n < 6) return null;
  let a = 0, b = 0, best = -1;
  for (let pass = 0; pass < 2; pass++) {
    const from = pass ? a : 0;
    best = -1;
    for (let i = 0; i < n; i++) { const d = dist(outline[from], outline[i]); if (d > best) { best = d; if (pass) b = i; else a = i; } }
  }
  if (a === b) return null;
  const [i0, i1] = a < b ? [a, b] : [b, a];
  const s1 = outline.slice(i0, i1 + 1), s2 = [...outline.slice(i1), ...outline.slice(0, i0 + 1)].reverse();
  const N = Math.max(8, Math.round(polyLen(s1, false) / 4));
  const rs = (s) => {
    const L = polyLen(s, false), out = [];
    let k = 0, acc = 0;
    for (let j = 0; j <= N; j++) {
      const t = (L * j) / N;
      while (k < s.length - 2 && acc + dist(s[k], s[k + 1]) < t) { acc += dist(s[k], s[k + 1]); k++; }
      const seg = dist(s[k], s[k + 1]) || 1, u = Math.min(1, Math.max(0, (t - acc) / seg));
      out.push([s[k][0] + (s[k + 1][0] - s[k][0]) * u, s[k][1] + (s[k + 1][1] - s[k][1]) * u]);
    }
    return out;
  };
  const r1 = rs(s1), r2 = rs(s2);
  return r1.map((p, j) => [(p[0] + r2[j][0]) / 2, (p[1] + r2[j][1]) / 2]);
}

export function findDetails(cv, rgba, outer, ppiIn, { sensitivity = 5, minSize = 0.75 } = {}) {
  // work at about 32 px per inch: plenty for the edges, and fast enough on a phone
  const sc = Math.min(1, 32 / ppiIn), ppi = ppiIn * sc;
  const mats = [];
  const M = (m) => { mats.push(m); return m; };
  const T0 = Date.now();
  try {
    const bb = bbox(outer);
    const x0 = Math.max(0, Math.floor(bb.x0) - 2), y0 = Math.max(0, Math.floor(bb.y0) - 2);
    const x1 = Math.min(rgba.cols, Math.ceil(bb.x1) + 2), y1 = Math.min(rgba.rows, Math.ceil(bb.y1) + 2);
    const roi0 = M(rgba.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0)));
    const roi = M(new cv.Mat());
    cv.resize(roi0, roi, new cv.Size(Math.max(1, Math.round(roi0.cols * sc)), Math.max(1, Math.round(roi0.rows * sc))), 0, 0, cv.INTER_AREA);
    const W = roi.cols, H = roi.rows;
    const rgb = M(new cv.Mat());
    cv.cvtColor(roi, rgb, cv.COLOR_RGBA2RGB);
    const gray = M(new cv.Mat());
    cv.cvtColor(roi, gray, cv.COLOR_RGBA2GRAY);

    // the part, shrunk a little so its own outline isn't found again
    const local = outer.map(([x, y]) => [(x - x0) * sc, (y - y0) * sc]);
    const partMask = M(cv.Mat.zeros(H, W, cv.CV_8UC1));
    const pv = M(cv.matFromArray(local.length, 1, cv.CV_32SC2, local.flatMap((p) => [Math.round(p[0]), Math.round(p[1])])));
    const pvv = M(new cv.MatVector()); pvv.push_back(pv);
    cv.fillPoly(partMask, pvv, new cv.Scalar(255));
    const inset = Math.max(3, Math.round(0.2 * ppi));
    const inner = M(new cv.Mat());
    // (outside the window counts as "not the part": the default border would keep a part that touches the window's edge)
    cv.erode(partMask, inner, M(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2 * inset + 1, 2 * inset + 1))), new cv.Point(-1, -1), 1, cv.BORDER_CONSTANT, new cv.Scalar(0));

    if (globalThis.__DBG) console.log('t0', Date.now() - T0);
    // blur away wood grain and photo noise; more sensitivity = less blur
    const sigma = Math.max(1.2, ppi * (0.075 - 0.005 * (sensitivity - 5)));
    const blur = M(new cv.Mat());
    cv.GaussianBlur(gray, blur, new cv.Size(0, 0), sigma, sigma, cv.BORDER_REPLICATE);
    // edge strength threshold from the photo itself: the strongest few percent of gradients inside the part
    const gx = M(new cv.Mat()), gy = M(new cv.Mat()), mag = M(new cv.Mat());
    cv.Sobel(blur, gx, cv.CV_32F, 1, 0, 3);
    cv.Sobel(blur, gy, cv.CV_32F, 0, 1, 3);
    cv.magnitude(gx, gy, mag);
    const share = 0.015 + 0.006 * sensitivity; // sensitivity 5 -> strongest 4.5 % of pixels count as edge
    let hi = percentile(cv, mag, inner, 1 - share);
    hi = Math.max(hi, 18 - sensitivity); // a blank, featureless part shouldn't turn noise into edges
    const edges = M(new cv.Mat());
    cv.Canny(blur, edges, hi * 0.28, hi, 3, true);
    cv.bitwise_and(edges, inner, edges);
    // close small gaps so outlines become loops
    const gap = Math.max(2, Math.round(0.05 * ppi));
    const kGap = M(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2 * gap + 1, 2 * gap + 1)));
    const closedEdges = M(new cv.Mat());
    cv.morphologyEx(edges, closedEdges, cv.MORPH_CLOSE, kGap);
    cv.dilate(closedEdges, closedEdges, M(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3))));

    if (globalThis.__DBG) console.log('t1', Date.now() - T0);
    // a pierced panel (fretwork, a grille): many areas much darker than the part, where you see through it.
    // Those are the details; they come straight from the dark areas, which is far more complete than edges.
    const cut = findCutouts(cv, gray, inner, ppi, minSize, M);
    if (cut) {
      const toIn = (p) => [p[0] / sc + x0, p[1] / sc + y0];
      const shapes = cut.map((pts) => {
        const bx = bbox(pts);
        return { pts: pts.map(toIn), closed: true, size: { w: (bx.x1 - bx.x0) / ppi, h: (bx.y1 - bx.y0) / ppi }, score: polyArea(pts) / ppi / ppi,
          guess: { cut: 'inside', why: 'A see-through cutout: much darker than the part, so you can see behind it. Cut all the way through.' } };
      });
      const edgeMap = new cv.Mat();
      closedEdges.copyTo(edgeMap);
      return { shapes, pierced: true, edges: { mat: edgeMap, x0, y0, sc, partMask: (() => { const m = new cv.Mat(); inner.copyTo(m); return m; })() }, threshold: hi };
    }
    const contours = M(new cv.MatVector()), hier = M(new cv.Mat());
    cv.findContours(closedEdges, contours, hier, cv.RETR_CCOMP, cv.CHAIN_APPROX_NONE);
    const h = hier.data32S;
    const minA = (minSize * ppi) ** 2;
    const minLen = Math.max(minSize, 1) * ppi;
    const cands = [], lines = [], pendingOutlines = [];
    const grow = Math.max(1, Math.round(gap / 2) + 1);
    const kGrow = M(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2 * grow + 1, 2 * grow + 1)));
    // outlines around groups of areas (a panel: bevel facets plus field) are found on a coarser edge map
    // where nearby edges and small breaks merge
    const wide = Math.max(3, Math.round(0.15 * ppi));
    const kWide = M(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2 * wide + 1, 2 * wide + 1)));
    const coarse = M(new cv.Mat());
    cv.dilate(closedEdges, coarse, kWide);
    {
      const cs = M(new cv.MatVector()), hh = M(new cv.Mat());
      cv.findContours(coarse, cs, hh, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
      for (let i = 0; i < cs.size(); i++) {
        const pts = contourPts(cs.get(i));
        if (pts.length < 8 || polyArea(pts) < minA) continue;
        const rm = M(cv.Mat.zeros(H, W, cv.CV_8UC1));
        const v = M(new cv.MatVector()); v.push_back(M(cv.matFromArray(pts.length, 1, cv.CV_32SC2, pts.flat())));
        cv.fillPoly(rm, v, new cv.Scalar(255));
        const own = M(new cv.Mat());
        cv.bitwise_and(rm, coarse, own);
        if (cv.countNonZero(rm) < cv.countNonZero(own) * 1.8) continue; // just a thick line, not around anything
        cv.erode(rm, rm, kWide); // now on the outer side of the edge band...
        cv.erode(rm, rm, kGrow); // ...and in to its middle
        pendingOutlines.push(rm);
      }
    }
    const fill = (pts) => {
      const rm = M(cv.Mat.zeros(H, W, cv.CV_8UC1));
      const v = M(new cv.MatVector()); v.push_back(M(cv.matFromArray(pts.length, 1, cv.CV_32SC2, pts.flat())));
      cv.fillPoly(rm, v, new cv.Scalar(255));
      return rm;
    };
    const outlineOf = (mask) => {
      const cs = M(new cv.MatVector()), hh = M(new cv.Mat());
      cv.findContours(mask, cs, hh, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
      let best = null;
      for (let k = 0; k < cs.size(); k++) { const q = contourPts(cs.get(k)); if (!best || polyArea(q) > polyArea(best)) best = q; }
      return best;
    };
    // thin spurs (a grain line or crack running off an outline) stick out of an area: trim them off,
    // without rounding its corners (open, then only keep what lies near the opened area)
    const spur = Math.max(3, Math.round(Math.min(0.2, minSize * 0.25) * ppi));
    const kSpur = M(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2 * spur + 1, 2 * spur + 1)));
    const trimSpurs = (mask) => {
      const o = new cv.Mat();
      cv.morphologyEx(mask, o, cv.MORPH_OPEN, kSpur);
      if (cv.countNonZero(o) > 0) { cv.dilate(o, o, kSpur); cv.bitwise_and(mask, o, mask); }
      o.delete();
    };
    const addCand = (mask, src) => {
      trimSpurs(mask);
      const pts = outlineOf(mask);
      if (!pts || pts.length < 8) return;
      const area = polyArea(pts);
      if (area < minA || area / polyLen(pts) < 0.08 * ppi) return;
      cands.push({ pts, area, mask, src });
      if (globalThis.__DBG) console.log('cand', src, (area / ppi / ppi).toFixed(1));
    };
    for (let i = 0; i < contours.size(); i++) {
      const parent = h[4 * i + 3];
      const c = contours.get(i);
      const pts = contourPts(c);
      c.delete();
      if (pts.length < 8) continue;
      const area = polyArea(pts), perim = polyLen(pts);
      if (parent >= 0) {
        // a hole in the edge map = an area fully surrounded by edges. Its border sits on the inside of the
        // edge band: grow it back to the middle of the band.
        if (area < minA || area / perim < 0.08 * ppi) continue;
        const rm = fill(pts);
        cv.dilate(rm, rm, kGrow);
        addCand(rm, 'hole');
      } else {
        // the outside border of a group of connected edges: if it surrounds much more than the edges
        // themselves, it is an outline around several areas (a panel with a bevel, for example)
        // if it's long and thin, it is a line (groove, carving)
        const bx = bbox(pts);
        if (Math.max(bx.x1 - bx.x0, bx.y1 - bx.y0) < minLen * 0.6) continue;
        if (perim / 2 < minLen) continue;
        if (area / (perim / 2) > 0.14 * ppi) continue; // too wide to be a line
        if (h[4 * i + 2] >= 0) continue; // has a hole: it's a region's border
        const cl = centerline(pts);
        if (cl && polyLen(cl, false) >= minLen) lines.push({ pts: cl, len: polyLen(cl, false) });
      }
    }

    if (globalThis.__DBG) console.log('t2', Date.now() - T0);
    for (const rm of pendingOutlines) addCand(rm, 'outline');

    if (globalThis.__DBG) console.log('t3', Date.now() - T0);
    // areas that aren't the part's own color (glass, an opening you can see through, a painted inlay)
    const ringIn = M(new cv.Mat());
    cv.erode(inner, ringIn, M(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(Math.round(ppi) | 1, Math.round(ppi) | 1))), new cv.Point(-1, -1), 1, cv.BORDER_CONSTANT, new cv.Scalar(0));
    cv.bitwise_xor(inner, ringIn, ringIn); // a band just inside the part's edge: almost always the part's own material
    let odd = null;
    {
      // wood keeps its hue in shadow; glass, openings and reflections don't. On a painted (gray/white)
      // part, only a big change in lightness counts.
      const hsv = M(new cv.Mat());
      cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV_FULL);
      const ch = M(new cv.MatVector());
      cv.split(hsv, ch);
      const H8 = ch.get(0), S8 = ch.get(1), V8 = ch.get(2);
      mats.push(H8, S8, V8);
      const hsvMean = cv.mean(hsv, ringIn);
      const sat0 = hsvMean[1] / 255, hue0 = hsvMean[0];
      odd = M(cv.Mat.zeros(H, W, cv.CV_8UC1));
      const hd = H8.data, sd = S8.data, vd = V8.data, od = odd.data, md = inner.data;
      const loose = (sensitivity - 5) * 0.02;
      if (sat0 > 0.12) {
        for (let i = 0; i < od.length; i++) {
          if (!md[i]) continue;
          const sat = sd[i] / 255, v = vd[i] / 255;
          let dh = Math.abs(hd[i] - hue0); if (dh > 128) dh = 256 - dh;
          const dhDeg = (dh * 360) / 256;
          if ((sat < sat0 * (0.45 + loose) && v > 0.08) || (dhDeg > 40 - 40 * loose && sat > 0.12)) od[i] = 255;
        }
      } else {
        const v0 = hsvMean[2] / 255;
        for (let i = 0; i < od.length; i++) if (md[i] && Math.abs(vd[i] / 255 - v0) > 0.35 - loose) od[i] = 255;
      }
      const k = Math.max(3, Math.round(0.12 * ppi)) | 1;
      const kk = M(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k)));
      cv.morphologyEx(odd, odd, cv.MORPH_OPEN, kk);
      cv.morphologyEx(odd, odd, cv.MORPH_CLOSE, kk);
      const cs = M(new cv.MatVector()), hh = M(new cv.Mat());
      cv.findContours(odd, cs, hh, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
      for (let i = 0; i < cs.size(); i++) {
        const pts = contourPts(cs.get(i));
        if (polyArea(pts) < minA) continue;
        addCand(fill(pts), 'color'); // outer border only: reflections inside glass don't punch holes
      }
    }

    if (globalThis.__DBG) console.log('t4', Date.now() - T0);
    // the same area found two ways: keep one (color > hole > outline)
    const rank = { color: 0, hole: 1, outline: 2 };
    cands.sort((a, b) => rank[a.src] - rank[b.src] || b.area - a.area);
    const regions = [];
    for (const c of cands) {
      const dup = regions.some((r) => {
        if (Math.min(r.area, c.area) / Math.max(r.area, c.area) < 0.8) return false;
        const both = M(new cv.Mat()), any = M(new cv.Mat());
        cv.bitwise_and(r.mask, c.mask, both); cv.bitwise_or(r.mask, c.mask, any);
        return cv.countNonZero(both) / (cv.countNonZero(any) || 1) > 0.85;
      });
      if (!dup) regions.push(c);
    }
    regions.sort((a, b) => b.area - a.area);
    // nesting: which region sits inside which
    // (by overlap: two areas that share an edge can have outlines a pixel apart either way)
    const within = (r, q) => {
      const both = new cv.Mat();
      cv.bitwise_and(r.mask, q.mask, both);
      const k = cv.countNonZero(both) / (cv.countNonZero(r.mask) || 1);
      both.delete();
      return k > 0.9;
    };
    const nest = () => {
      for (const r of regions) {
        r.parent = null;
        for (const q of regions) if (q !== r && q.area > r.area && within(r, q)) { if (!r.parent || q.area < r.parent.area) r.parent = q; }
      }
    };
    nest();
    // a raised panel's bevel shows up as several facets between the panel outline and the field: drop them
    for (const p of regions) {
      const kids = regions.filter((q) => q.parent === p);
      if (kids.length < 2) continue;
      const field = kids[0]; // largest
      if (!ringLike(p, field, ppi)) continue;
      for (const k of kids.slice(1)) if (!within(k, field)) k.drop = true;
    }
    for (let i = regions.length - 1; i >= 0; i--) if (regions[i].drop || (regions[i].parent && regions[i].parent.drop)) regions.splice(i, 1);
    nest();
    const kr = (inches) => { const r = Math.max(1, Math.round(inches * ppi)); return M(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2 * r + 1, 2 * r + 1))); };
    // drop lines that just run along a region's border (both sides of the same edge)
    const nearRegion = (p) => regions.some((r) => r.pts.some((q) => Math.abs(q[0] - p[0]) < gap * 3 && Math.abs(q[1] - p[1]) < gap * 3));
    // ...and lines hugging the part's own edge (its shadow, a chamfer, the outline traced a hair off)
    const deep = M(new cv.Mat());
    cv.erode(partMask, deep, kr(0.35), new cv.Point(-1, -1), 1, cv.BORDER_CONSTANT, new cv.Scalar(0));
    const nearEdge = (p) => deep.ucharPtr(Math.min(H - 1, Math.max(0, Math.round(p[1]))), Math.min(W - 1, Math.max(0, Math.round(p[0]))))[0] === 0;
    const keptLines = lines.filter((l) => l.pts.filter(nearRegion).length < l.pts.length * 0.5 && l.pts.filter(nearEdge).length < l.pts.length * 0.5);
    // ...and lines inside a see-through area (reflections in glass) are dropped after the regions are classified

    if (globalThis.__DBG) console.log('t5', Date.now() - T0);
    // ---- guess how each region is cut
    const k06 = kr(0.06), k15 = kr(0.15), k30 = kr(0.3);
    const meanIn = (mat, mask) => (cv.countNonZero(mask) ? cv.mean(mat, mask)[0] : NaN);
    for (const r of regions) {
      // work in a window around the region only
      const bx = bbox(r.pts), mg = Math.round(0.45 * ppi);
      const rx = Math.max(0, bx.x0 - mg), ry = Math.max(0, bx.y0 - mg);
      const rect = new cv.Rect(rx, ry, Math.min(W, bx.x1 + mg + 1) - rx, Math.min(H, bx.y1 + mg + 1) - ry);
      const rm = M(r.mask.roi(rect)), bl = M(blur.roi(rect)), od = M(odd.roi(rect)), inn = M(inner.roi(rect));
      const t1 = M(new cv.Mat()), t2 = M(new cv.Mat()), band = M(new cv.Mat()), inRing = M(new cv.Mat()), outRing = M(new cv.Mat()), core = M(new cv.Mat());
      cv.dilate(rm, t1, k06); cv.erode(rm, t2, k06); cv.bitwise_xor(t1, t2, band);
      cv.erode(rm, t1, k15); cv.erode(rm, t2, k30); cv.bitwise_xor(t1, t2, inRing);
      cv.dilate(rm, t1, k30); cv.dilate(rm, t2, k15); cv.bitwise_xor(t1, t2, outRing); cv.bitwise_and(outRing, inn, outRing);
      cv.erode(rm, core, k30);
      r.lBand = meanIn(bl, band); r.lIn = meanIn(bl, inRing); r.lOut = meanIn(bl, outRing);
      // how much of the inside is "not the part's material" (glass, an opening)
      const oddIn = M(new cv.Mat());
      cv.bitwise_and(od, core, oddIn);
      r.oddShare = cv.countNonZero(oddIn) / (cv.countNonZero(core) || 1);
      cv.bitwise_and(od, inRing, oddIn);
      r.oddRing = cv.countNonZero(oddIn) / (cv.countNonZero(inRing) || 1);
    }
    if (globalThis.__DBG) console.log('t6', Date.now() - T0);
    const shapes = [];
    const toIn = (p) => [p[0] / sc + x0, p[1] / sc + y0];
    for (const r of regions) {
      const bx = bbox(r.pts);
      const size = { w: (bx.x1 - bx.x0) / ppi, h: (bx.y1 - bx.y0) / ppi };
      const lineLike = r.lBand < Math.min(r.lIn, r.lOut) - 5 && Math.abs(r.lIn - r.lOut) < 20 && r.oddRing < 0.3;
      const seeThrough = r.oddShare > 0.6 && r.oddRing > 0.5;
      const child = regions.find((q) => q.parent === r);
      let guess;
      if (seeThrough && r.parent?.guess?.cut !== 'inside') guess = { cut: 'inside', why: 'Looks see-through (glass or an opening): not the same material as the part around it.' };
      else if (lineLike) guess = { cut: 'groove', why: 'A thin dark line with the same surface on both sides: a groove or V-carve.' };
      else if (r.parent && r.parent.guess?.cut === 'profile' && r.parent.ring) guess = { cut: 'skip', why: 'The flat field of a raised panel. The raised-panel bit makes this edge, so it is usually not a separate cut.' };
      else if (child && ringLike(r, child, ppi)) { guess = { cut: 'profile', why: 'Panel outline with a sloped band (bevel) inside it: a raised-panel profile.' }; r.ring = true; }
      else guess = { cut: 'pocket', why: 'An area inside the part with its own edge: a recess (pocket) is the usual cut. Check the depth.' };
      r.guess = guess;
      if (globalThis.__DBG) console.log('region', size.w.toFixed(2), size.h.toFixed(2), r.src, { band: r.lBand.toFixed(1), in: r.lIn.toFixed(1), out: r.lOut.toFixed(1), odd: r.oddShare.toFixed(2), oddRing: r.oddRing.toFixed(2) }, guess.cut);
      shapes.push({ pts: r.pts.map(toIn), closed: true, guess, size, score: r.area / ppi / ppi });
    }
    const clear = regions.filter((r) => r.guess.cut === 'inside');
    for (const l of keptLines) {
      if (l.pts.filter((p) => clear.some((r) => pointInPoly(p, r.pts))).length > l.pts.length * 0.3) continue;
      const bx = bbox(l.pts);
      shapes.push({ pts: l.pts.map(toIn), closed: false, guess: { cut: 'groove', why: 'A line inside the part: a groove or carved line.' },
        size: { w: (bx.x1 - bx.x0) / ppi, h: (bx.y1 - bx.y0) / ppi }, score: l.len / ppi });
    }
    // keep the edge map for "tap to add a region"
    const edgeMap = new cv.Mat();
    closedEdges.copyTo(edgeMap);
    return { shapes, edges: { mat: edgeMap, x0, y0, sc, partMask: (() => { const m = new cv.Mat(); inner.copyTo(m); return m; })() }, threshold: hi };
  } finally {
    for (const m of mats) { try { m.delete(); } catch { /* already freed */ } }
  }
}

// Dark see-through cutouts inside the part, or null when the part isn't pierced. The part's brightness
// splits in two (Otsu); it counts as pierced when the dark side is clearly darker and made of several
// solid areas (one dark area is glass or a panel, and thin dark lines are grooves or shadows).
function findCutouts(cv, gray, inner, ppi, minSize, M) {
  const gd = gray.data, md = inner.data, hist = new Float64Array(256);
  let n = 0;
  for (let i = 0; i < gd.length; i++) if (md[i]) { hist[gd[i]]++; n++; }
  if (n < 100) return null;
  let sum = 0; for (let v = 0; v < 256; v++) sum += v * hist[v];
  let wB = 0, sB = 0, best = -1, t = 0;
  for (let v = 0; v < 256; v++) {
    wB += hist[v]; if (!wB) continue;
    const wF = n - wB; if (!wF) break;
    sB += v * hist[v];
    const mB = sB / wB, mF = (sum - sB) / wF, between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; t = v; }
  }
  let nd = 0, sd = 0; for (let v = 0; v <= t; v++) { nd += hist[v]; sd += v * hist[v]; }
  const lo = sd / (nd || 1), hiM = (sum - sd) / ((n - nd) || 1), share = nd / n;
  if (globalThis.__DBG) console.log('cutouts?', { t, lo: lo.toFixed(0), hi: hiM.toFixed(0), share: share.toFixed(2) });
  if (share < 0.04 || share > 0.65 || hiM - lo < 40 || lo > hiM * 0.6) return null;
  const dark = M(new cv.Mat());
  cv.threshold(gray, dark, t, 255, cv.THRESH_BINARY_INV);
  cv.bitwise_and(dark, inner, dark);
  cv.morphologyEx(dark, dark, cv.MORPH_OPEN, M(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3))));
  const cs = M(new cv.MatVector()), hh = M(new cv.Mat());
  cv.findContours(dark, cs, hh, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
  const smallest = Math.max(0.15, Math.min(minSize, 1) * 0.3) * ppi;
  const out = [];
  let total = 0;
  for (let i = 0; i < cs.size(); i++) {
    const pts = contourPts(cs.get(i));
    if (pts.length < 6) continue;
    const a = polyArea(pts), bx = bbox(pts);
    if (Math.max(bx.x1 - bx.x0, bx.y1 - bx.y0) < smallest || a < (smallest * 0.6) ** 2) continue;
    if (a / polyLen(pts) < 0.05 * ppi) continue; // a thin dark line: a groove or a shadow, not a hole
    // cut off by the edge of the search area: a shadow or hardware at the part's edge, not a cutout
    const onRim = pts.filter(([x, y]) => [[-2, 0], [2, 0], [0, -2], [0, 2]].some(([dx, dy]) => {
      const xx = x + dx, yy = y + dy;
      return xx < 0 || yy < 0 || xx >= inner.cols || yy >= inner.rows || !md[yy * inner.cols + xx];
    })).length;
    if (onRim > pts.length * 0.2) continue;
    out.push(pts); total += a;
  }
  if (globalThis.__DBG) console.log('cutouts', out.length, (total / n).toFixed(3));
  return out.length >= 5 && total > n * 0.03 ? out : null;
}

// Is `child` sitting inside `r` at a fairly even distance (a bevel band) rather than just somewhere inside?
function ringLike(r, child, ppi) {
  const step = Math.max(1, Math.floor(r.pts.length / 120));
  const ds = [];
  for (let i = 0; i < r.pts.length; i += step) {
    const p = r.pts[i];
    let best = Infinity;
    for (let j = 0; j < child.pts.length; j += 2) { const d = dist(p, child.pts[j]); if (d < best) best = d; }
    ds.push(best / ppi);
  }
  ds.sort((a, b) => a - b);
  const med = ds[ds.length >> 1], p90 = ds[Math.floor(ds.length * 0.9)];
  if (globalThis.__DBG) console.log("ring", med.toFixed(2), p90.toFixed(2), (child.area / r.area).toFixed(2));
  // (p90 may be up to 2": where the field runs into the bevel in the photo, part of the band reads as 0)
  return med > 0.4 && med < 3.5 && p90 < Math.max(med * 2.2, 2) && child.area > r.area * 0.35;
}

// The closed area around a tapped point (px), bounded by the edges found by findDetails. Null if it leaks
// out to the part's border (no closed edge around that point).
export function regionAt(cv, found, point) {
  const { mat, x0, y0, sc, partMask } = found.edges;
  const x = Math.round((point[0] - x0) * sc), y = Math.round((point[1] - y0) * sc);
  if (x < 0 || y < 0 || x >= mat.cols || y >= mat.rows) return null;
  if (mat.ucharPtr(y, x)[0]) return null; // tapped right on an edge
  const ff = new cv.Mat.zeros(mat.rows + 2, mat.cols + 2, cv.CV_8UC1);
  const work = new cv.Mat();
  try {
    // walls = edges plus everything outside the part
    const walls = new cv.Mat();
    cv.bitwise_not(partMask, walls);
    cv.bitwise_or(walls, mat, walls);
    walls.copyTo(work);
    walls.delete();
    cv.floodFill(work, ff, new cv.Point(x, y), new cv.Scalar(128), new cv.Rect(), new cv.Scalar(0), new cv.Scalar(0), 4 | (255 << 8) | cv.FLOODFILL_MASK_ONLY);
    const region = ff.roi(new cv.Rect(1, 1, mat.cols, mat.rows));
    const r = new cv.Mat();
    region.copyTo(r);
    region.delete();
    // leaked to the part border?
    const border = new cv.Mat();
    cv.dilate(partMask, border, cv.Mat.ones(3, 3, cv.CV_8U));
    cv.bitwise_xor(border, partMask, border);
    cv.bitwise_and(border, r, border);
    const leaks = cv.countNonZero(border) > 0;
    border.delete();
    const area = cv.countNonZero(r);
    const total = cv.countNonZero(partMask);
    if (leaks || area > total * 0.95) { r.delete(); return null; }
    cv.dilate(r, r, cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5)));
    const cs = new cv.MatVector(), hh = new cv.Mat();
    cv.findContours(r, cs, hh, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
    let best = null;
    for (let k = 0; k < cs.size(); k++) { const q = contourPts(cs.get(k)); if (!best || q.length > best.length) best = q; }
    cs.delete(); hh.delete(); r.delete();
    return best ? best.map((p) => [p[0] / sc + x0, p[1] / sc + y0]) : null;
  } finally {
    ff.delete(); work.delete();
  }
}

export function freeDetails(found) {
  if (!found?.edges) return;
  try { found.edges.mat.delete(); found.edges.partMask.delete(); } catch { /* freed */ }
}
