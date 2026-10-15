"""Re-opens a layered DXF with ezdxf: audit, units, per-layer entity types and closed/open contours.
Prints JSON. Usage: python3 tests/verify_layers.py file.dxf"""
import json, sys
import ezdxf
from ezdxf import bbox as ezbbox

OPEN_OK = ('VGROOVE', 'GROOVE', 'PROFILE_EDGE')
doc = ezdxf.readfile(sys.argv[1])
audit = doc.audit()
msp = doc.modelspace()
layers = {}
for e in msp:
    layers.setdefault(e.dxf.layer, []).append(e)
def loops(ents, eps=1e-4):
    segs = []
    for e in ents:
        if e.dxftype() == 'LINE': segs.append(((e.dxf.start.x, e.dxf.start.y), (e.dxf.end.x, e.dxf.end.y)))
        elif e.dxftype() == 'ARC': segs.append(((e.start_point.x, e.start_point.y), (e.end_point.x, e.end_point.y)))
    used = [False] * len(segs); out = []
    d = lambda p, q: abs(p[0] - q[0]) + abs(p[1] - q[1])
    for i in range(len(segs)):
        if used[i]: continue
        used[i] = True; start, end = segs[i]; n = 1
        while d(end, start) > eps:
            k = next((j for j in range(len(segs)) if not used[j] and (d(segs[j][0], end) <= eps or d(segs[j][1], end) <= eps)), None)
            if k is None: break
            used[k] = True; n += 1
            end = segs[k][1] if d(segs[k][0], end) <= eps else segs[k][0]
        out.append(d(end, start) <= eps)
    return out
res = {'audit_errors': len(audit.errors), 'units': doc.units, 'layers': {}, 'ok': True}
for name, ents in layers.items():
    types = sorted({e.dxftype() for e in ents})
    ls = loops(ents)
    closed_ok = all(ls) or name.startswith(OPEN_OK)
    res['layers'][name] = {'types': types, 'shapes': len(ls), 'closed': sum(ls), 'in_table': name in doc.layers}
    if not closed_ok or any(t not in ('LINE', 'ARC') for t in types) or name not in doc.layers: res['ok'] = False
ext = ezbbox.extents(msp)
res['min'] = [round(ext.extmin.x, 4), round(ext.extmin.y, 4)]
res['size'] = [round(ext.size.x, 4), round(ext.size.y, 4)]
if abs(res['min'][0]) > 1e-3 or abs(res['min'][1]) > 1e-3 or doc.units != 1: res['ok'] = False
print(json.dumps(res))
