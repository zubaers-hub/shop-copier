# Shop Copier

A phone web app for the shop. Two tools:

1. **Shape → DXF.** Photo of a part, tap the 4 corners of something rectangular (a sheet of paper works), type its size, auto-detect or trace the outline, clean it up into true lines and arcs, mirror it if it's symmetric, and download a DXF for Mozaik's Part Editor → DXF In.
2. **Cabinet build sheet.** Photo of a run of cabinets; Claude lists each box left to right with sizes, doors, drawers and style. Everything is editable, and it prints as a build sheet. Decorative parts get a button that sends the same photo to Shape → DXF.

Everything runs on the phone. Jobs save on the phone. The Claude API key is typed once in ⚙ Settings and stays on the phone; photos go straight from the phone to Anthropic.

## Files

- The live app is on GitHub Pages: https://zubaers-hub.github.io/shop-copier/ (served from the `gh-pages` branch, which holds the built `dist/` folder). It must be served over **https** for the camera button and offline mode to work.
- `src/` source. `src/core.js` has all the geometry and the DXF writer and checker (no browser needed).
- `tests/` the tests and their outputs (see TEST-REPORT.md).
- `tools/build.mjs` rebuilds `dist/` (`npm install` then `node tools/build.mjs`).

## Trying it on a computer

`cd dist && python3 -m http.server 8765`, then open http://localhost:8765. (On a phone it needs https, which GitHub Pages gives you.)

## Updating the live site

`node tools/build.mjs`, then copy `dist/` to the `gh-pages` branch and push.

## DXF details (what Mozaik gets)

- Units inches. DXF 2000 by default (stores `$INSUNITS = 1`); R12 is a Settings option (R12 has no units field, values are inches).
- One closed outline on layer `OUTLINE`, each cutout its own closed contour on layer `CUTOUT` (layer names editable in Settings).
- Only LINE and ARC entities. No splines or polylines.
- Lower-left corner of the part at 0,0.
- Every export is re-opened by the app and checked before you download it (closed, lines/arcs only, units, 0,0, size).

## Accuracy, honestly

A photo is not a tape measure. Lens distortion (wide phone lenses bow straight edges near the frame edges), the reference rectangle not being in the same plane as the part, and parts that aren't flat all add error. In testing, a clean photo gave sizes within about 1/32" and the outline within 1/32"; shaky hand traces were within 1/16" on size in 49 of 50 runs (worst about 3/32"). Measure one real edge with a tape and check the DXF before cutting anything expensive.
