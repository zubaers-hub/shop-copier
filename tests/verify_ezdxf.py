"""Independent re-open of the exported DXF files with ezdxf (a separate CAD library, not the app's own parser).
Checks: file loads and audits clean, units are inches, only LINE/ARC, every contour closed, lower-left at 0,0,
overall size. Also renders a PNG preview of each file.  Run: python3 tests/verify_ezdxf.py tests/out"""
import json, math, sys
from pathlib import Path
import ezdxf
from ezdxf import bbox

EXPECT = {  # file stem prefix -> (width, height, contours)
    "arched-door-top": (15, 27, 1),
    "corbel-hand-traced": (6, 10, 1),
    "corbel": (6, 10, 2),
    "cathedral-door-top": (16, 30, 1),
}

def endpoints(e):
    if e.dxftype() == "LINE":
        return (e.dxf.start.x, e.dxf.start.y), (e.dxf.end.x, e.dxf.end.y)
    c, r = e.dxf.center, e.dxf.radius
    a0, a1 = math.radians(e.dxf.start_angle), math.radians(e.dxf.end_angle)
    return (c.x + r * math.cos(a0), c.y + r * math.sin(a0)), (c.x + r * math.cos(a1), c.y + r * math.sin(a1))

def loops(ents, eps=1e-4):
    segs = [endpoints(e) for e in ents]
    used = [False] * len(segs)
    out = []
    for i in range(len(segs)):
        if used[i]:
            continue
        used[i] = True
        start, end = segs[i]
        n = 1
        while math.dist(start, end) > eps:
            for k, (a, b) in enumerate(segs):
                if used[k]:
                    continue
                if math.dist(a, end) <= eps:
                    used[k] = True; end = b; n += 1; break
                if math.dist(b, end) <= eps:
                    used[k] = True; end = a; n += 1; break
            else:
                break
        out.append((n, math.dist(start, end) <= eps))
    return out

def main(folder):
    folder = Path(folder)
    results, ok_all = [], True
    for f in sorted(folder.glob("*.dxf")):
        exp = next(v for k, v in EXPECT.items() if f.stem.startswith(k))
        doc = ezdxf.readfile(f)
        auditor = doc.audit()
        msp = doc.modelspace()
        ents = list(msp)
        kinds = sorted({e.dxftype() for e in ents})
        lp = loops(ents)
        box = bbox.extents(msp)
        units = doc.header.get("$INSUNITS", None)
        r = {
            "file": f.name,
            "version": doc.dxfversion,
            "audit_errors": len(auditor.errors),
            "units": "inches" if units == 1 else ("not stored (R12)" if doc.dxfversion == "AC1009" else units),
            "entity_types": kinds,
            "lines": sum(e.dxftype() == "LINE" for e in ents),
            "arcs": sum(e.dxftype() == "ARC" for e in ents),
            "contours": len(lp),
            "all_closed": all(c for _, c in lp),
            "min_xy": [round(box.extmin.x, 4), round(box.extmin.y, 4)],
            "size": [round(box.size.x, 4), round(box.size.y, 4)],
            "expected_size": exp[:2],
        }
        r["ok"] = (r["audit_errors"] == 0 and kinds and set(kinds) <= {"LINE", "ARC"} and r["all_closed"]
                   and r["contours"] == exp[2] and abs(box.extmin.x) < 1e-4 and abs(box.extmin.y) < 1e-4
                   and abs(box.size.x - exp[0]) <= 1 / 16 and abs(box.size.y - exp[1]) <= 1 / 16
                   and (units == 1 or doc.dxfversion == "AC1009"))
        ok_all &= bool(r["ok"])
        results.append(r)
        print(("PASS " if r["ok"] else "FAIL ") + json.dumps(r))
        try:
            from ezdxf.addons.drawing import matplotlib as dm
            dm.qsave(msp, str(f.with_suffix(".png")), bg="#FFFFFF", dpi=60)
        except Exception as ex:  # preview is a nice-to-have
            print("  (preview not rendered:", ex, ")")
    (folder / "ezdxf-report.json").write_text(json.dumps(results, indent=2))
    return 0 if ok_all else 1

if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "tests/out"))
