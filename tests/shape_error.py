"""How far is a DXF outline from the true corbel shape? Prints the worst and average gap in inches,
and where the worst gap is. Usage: python3 tests/shape_error.py file.dxf"""
import sys, math, json
import ezdxf
from ezdxf import path as ezpath
sys.path.insert(0, 'tests')
import numpy as np
from make_photo_shapes import corbel_outline

doc = ezdxf.readfile(sys.argv[1])
msp = doc.modelspace()
pts = []
for e in msp:
    if e.dxf.layer.upper() != 'OUTLINE': continue
    p = ezpath.make_path(e)
    pts += [(v.x, v.y) for v in p.flattening(0.002)]
P = np.array(pts)
truth = np.array([(x, 10 - y) for x, y in corbel_outline()])
def seg_dist(points, poly):
    a = poly; b = np.roll(poly, -1, axis=0)
    ab = b - a; l2 = (ab ** 2).sum(1)
    out = []
    for p in points:
        t = np.clip(((p - a) * ab).sum(1) / np.where(l2 == 0, 1, l2), 0, 1)
        d = np.hypot(*(p - a - ab * t[:, None]).T)
        out.append(d.min())
    return np.array(out)
d1 = seg_dist(P, truth)     # file -> truth
d2 = seg_dist(truth, P)     # truth -> file
i = int(np.argmax(d2))
print(json.dumps({"worst_gap_in": round(float(max(d1.max(), d2.max())), 4), "mean_gap_in": round(float(np.r_[d1, d2].mean()), 4),
                  "worst_at_truth_xy": [round(float(v), 2) for v in truth[i]]}))
