"""The true corbel outline used by the photo test (inches, y down, 6 x 10)."""
import math

def arc_pts(a, m, b, n=60):
    ax, ay = a; mx, my = m; bx, by = b
    dd = 2 * (ax * (my - by) + mx * (by - ay) + bx * (ay - my))
    ux = ((ax*ax + ay*ay) * (my - by) + (mx*mx + my*my) * (by - ay) + (bx*bx + by*by) * (ay - my)) / dd
    uy = ((ax*ax + ay*ay) * (bx - mx) + (mx*mx + my*my) * (ax - bx) + (bx*bx + by*by) * (mx - ax)) / dd
    r = math.hypot(ax - ux, ay - uy)
    t0, tm, t1 = (math.atan2(p[1] - uy, p[0] - ux) for p in (a, m, b))
    def norm(t): return t % (2 * math.pi)
    ccw = norm(tm - t0) < norm(t1 - t0)
    sweep = norm(t1 - t0) if ccw else -norm(t0 - t1)
    return [(ux + r * math.cos(t0 + sweep * i / n), uy + r * math.sin(t0 + sweep * i / n)) for i in range(n + 1)]


HALF = [("L", (3, 0), (6, 0)), ("L", (6, 0), (6, 1.5)), ("A", (6, 1.5), (5.15, 2.75), (4.5, 4.5)),
        ("A", (4.5, 4.5), (4.75, 6.4), (4.25, 8)), ("L", (4.25, 8), (4.25, 10)), ("L", (4.25, 10), (3, 10))]

def corbel_outline():
    pts = []
    for s in HALF:
        pts += [s[1], s[2]] if s[0] == "L" else arc_pts(s[1], s[2], s[3])
    return pts + [(6 - x, y) for (x, y) in reversed(pts)]
