# What was tested

## 1. The DXF test you asked for: arched door top and symmetric corbel

`tests/dxf.test.mjs` makes shaky "traced" points for each part (25 points per inch, about 1 px of hand wobble, like tracing on a phone), runs them through the same cleanup and DXF writer the app uses, writes the files to `tests/out/`, then re-opens each file and checks it.

| File | Closed | Only lines + arcs | Units | Size in file | Expected |
|---|---|---|---|---|---|
| arched-door-top-R2000.dxf (mirrored) | 1 of 1 | 3 lines, 2 arcs | inches ($INSUNITS 1) | 14.997 × 26.990 | 15 × 27 |
| arched-door-top-R12.dxf | 1 of 1 | 3 lines, 2 arcs | R12 (inches, no units field) | 14.997 × 26.990 | 15 × 27 |
| arched-door-top-no-mirror-R2000.dxf | 1 of 1 | 3 lines, 1 arc | inches | 14.997 × 26.996 | 15 × 27 |
| cathedral-door-top-R2000.dxf | 1 of 1 | 3 lines, 2 arcs | inches | 15.993 × 30.013 | 16 × 30 |
| corbel-R2000.dxf (with 1" hole) | 2 of 2 | 4 lines, 8 arcs | inches | 5.975 × 9.994 | 6 × 10 |
| corbel-R12.dxf | 2 of 2 | 4 lines, 8 arcs | R12 | 5.975 × 9.994 | 6 × 10 |
| corbel-hand-traced-R2000.dxf (tap-by-tap trace) | 1 of 1 | 6 lines, 4 arcs | inches | 6.000 × 10.000 | 6 × 10 |

All have the lower-left corner at 0,0 and the mirrored ones are exactly symmetric. 57 of 57 checks pass.

**Second opinion:** `tests/verify_ezdxf.py` re-opens every file with ezdxf (an independent DXF library): 0 audit errors on all 7, units and sizes as above. It also draws each file to a PNG next to it so you can look.

**Shaky hands:** the whole test was repeated with 50 different random wobble patterns. 49 of 50 came out within 1/16" on every size; the worst was a corbel 10.08" tall instead of 10" (about 3/32"). Compared against the true corbel shape, the outline was within 0.083" everywhere (average 0.016").

## 2. The real app on a phone-sized screen (iPhone 13 size, Chromium)

`tests/e2e-shape.mjs` drives the actual app with taps, like a person would. Screenshots are in `tests/e2e-out/`.

- Photo: `tests/make_photo.py` makes a fake phone photo: a dark 6" × 10" corbel with a 1" hole next to a letter sheet of paper, shot at an angle with noise and JPEG blur.
- Steps: new job, choose photo, tap the 4 paper corners, enter 8 1/2 × 11, tap inside the corbel, auto-detect (dark part mode), mirror on, find center, export, download DXF and PNG, reload and check the job is still saved.
- Result: `corbel-from-photo.dxf` has 2 closed contours, 6 lines and 6 arcs, inches, size 5.975 × 9.999. Compared to the true shape, the outline is within 0.032" everywhere (average 0.012"). ezdxf: 0 audit errors.

It caught two real bugs, both fixed:
- Auto-detect never finished: the edge-finding library never reported "ready". Fixed in `src/vision.js`.
- The short straight edge at the top of the corbel was blended into the curve below it, off by about 1/8". Clean auto-detected outlines now find gentler corners. The shaky-hand results above didn't change.

## 3. Cabinet build sheet (Claude simulated)

There's no API key here, so Claude's API was simulated. `tests/e2e-cabinets.mjs`, 26 of 26 checks pass:
- The key is saved on the device.
- The request has the key, the browser-access header, the model, a JSON-format answer, the photo and your measurement.
- A bad key, a refusal, and an account without the newer fallback feature each give a clear message or a retry.
- Widths come back rounded to 3" steps, and a hand-edited width (22 1/2) stays.
- The sheet marks estimates with ≈, lists the style, and flags the valance for Shape → DXF.
- "Trace in Shape → DXF" opens a new shape job with the same photo.
- Claude is asked where each cabinet and decorative part sits in the photo; the Boxes step and the printed sheet show the photo with each one outlined and numbered like the list (base blue, wall green, tall orange, decorative purple D1, D2…), and tapping a box on the photo jumps to it in the list.
- Each flagged decorative part shows a close-up of where it is in the photo. "Trace" opens Shape → DXF with that close-up, its name and description in a strip at the top, the corner step zoomed on the part and outlined. After the DXF is saved, "Done, back to …" returns to the build sheet at that part, ticked off ("1 of 1 traced", file name and size), and the printed sheet marks it ✓. Opening it again reopens the same shape job.

**Not tested:** a real Claude call on a real cabinet photo, or how good its estimates are. That needs your key.

**Also not tested:** Mozaik itself and a real phone camera. The files follow the DXF rules Mozaik's DXF In expects, but import one test part in Mozaik before cutting.

## 4. Interior details on two door photos (`tests/e2e-doors.mjs`, 39 of 39 checks pass)

`tests/make_door_photos.py` draws two 15" × 28" doors photographed at an angle on a gray wall, with known true shapes: a raised-panel cathedral door and a door with a glass lite and a V-groove around it. The test drives the real app in a phone-sized Chromium: corners, size, outline auto-detect, Find details (sensitivity 5, minimum size 3/4"), cut types, mirror, export, then re-opens both DXFs with the app's checker and with ezdxf.

| Door | Found | Cut guessed | Found size vs true | DXF shape vs true (mean / worst) |
|---|---|---|---|---|
| Cathedral | frame opening | profile edge | 10.07 × 21.44 vs 10 × 21.5 | 0.062" / 0.108" |
| Cathedral | flat field | not cut | 9.72 × 20.06 vs 7 × 18.5 (merges with the arch bevel in the photo) | not exported |
| Glass | glass opening | inside cut | 10.00 × 23.00 vs 10 × 23 | 0.022" / 0.048" (4 lines, 4 arcs) |
| Glass | V-groove loop | groove | 11.72 × 24.72 vs 11.8 × 24.8 | 0.056" / 0.086" (4 lines, 4 arcs) |

No extra shapes were found on either door. Find details took about 1 second. Also checked: picking a shape by tapping it, the cut buttons and depth field, the bit list, drawing a groove line by hand, tap-an-area to add a shape, remove and undo, hiding a layer in the legend, the outline-only file, and "Suggest details" with Claude simulated (request goes to Sonnet 5.5 with the photo and numbered shapes; the answer relabels shapes and adds a missed line).

`tests/dxf.test.mjs` adds a layered door (66 of 66 checks): one layer per cut type in R2000 and R12, the groove stays open, "not cut" is left out, and the outline-only file has just the outline.

**Not tested:** real door photos (only drawn ones), a real Claude call, and Mozaik / your CAM reading the layers. Raised-panel fields often blend into the bevel in a photo; that doesn't affect the file because the field isn't cut, but check the profile line before cutting.
