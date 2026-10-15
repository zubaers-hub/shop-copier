"""Fake phone photos of two cabinet doors, for testing interior-detail detection.

  cathedral: 15" x 28" stained door with a cathedral raised panel (frame opening with a 1 1/2" bevel
             down to a flat raised field), wood grain, lit from the upper left.
  glass:     15" x 28" door with a 10" x 23" glass opening (rounded corners) and a decorative V-groove
             loop around it, glass showing reflections.

Each is photographed at an angle with noise and JPEG blur. Writes tests/doors/<name>.jpg,
<name>-flat.png (the straight-on render, 60 px per inch, door only) and <name>.json (truth: door corners
in the photo, feature outlines in inches from the door's top-left, y down)."""
import json, math, os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'doors')
os.makedirs(OUT, exist_ok=True)
PPI = 60
DW, DH = 15.0, 28.0
rng = np.random.default_rng(3)

def circ3(a, m, b):
    ax, ay = a; mx, my = m; bx, by = b
    d = 2 * (ax * (my - by) + mx * (by - ay) + bx * (ay - my))
    ux = ((ax*ax + ay*ay) * (my - by) + (mx*mx + my*my) * (by - ay) + (bx*bx + by*by) * (ay - my)) / d
    uy = ((ax*ax + ay*ay) * (bx - mx) + (mx*mx + my*my) * (ax - bx) + (bx*bx + by*by) * (mx - ax)) / d
    return ux, uy, math.hypot(ax - ux, ay - uy)

def arc(a, m, b, n=80):
    ux, uy, r = circ3(a, m, b)
    t0, tm, t1 = (math.atan2(p[1] - uy, p[0] - ux) for p in (a, m, b))
    nm = lambda t: t % (2 * math.pi)
    sweep = nm(t1 - t0) if nm(tm - t0) < nm(t1 - t0) else -nm(t0 - t1)
    return [(ux + r * math.cos(t0 + sweep * i / n), uy + r * math.sin(t0 + sweep * i / n)) for i in range(n + 1)]

def line(a, b, step=0.05):
    n = max(1, int(math.hypot(b[0] - a[0], b[1] - a[1]) / step))
    return [(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n) for i in range(n + 1)]

def rounded_rect(x0, y0, x1, y1, r):
    pts = []
    for (cx, cy, a0) in [(x1 - r, y0 + r, -90), (x1 - r, y1 - r, 0), (x0 + r, y1 - r, 90), (x0 + r, y0 + r, 180)]:
        pts += [(cx + r * math.cos(math.radians(a0 + k)), cy + r * math.sin(math.radians(a0 + k))) for k in range(0, 91, 3)]
    return pts

def wood(w, h, base, vertical=True, seed=0):
    """Wood-grain texture: wavy streaks along the grain plus fine noise."""
    r = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    along, across = (yy, xx) if vertical else (xx, yy)
    warp = 6 * np.sin(along / 90.0 + r.uniform(0, 6)) + 3 * np.sin(along / 37.0 + r.uniform(0, 6))
    g = np.sin((across + warp) / 3.1) * 0.5 + np.sin((across + warp * 1.7) / 7.3) * 0.35 + np.sin((across + warp * 0.6) / 17.0) * 0.4
    g += r.normal(0, 0.25, (h, w))
    img = np.array(base, np.float32)[None, None, :] * (1 + 0.07 * g[..., None])
    return img

def render_cathedral():
    W, H = int(DW * PPI), int(DH * PPI)
    img = wood(W, H, (150, 98, 58), True, 1)
    # frame opening (where the raised-panel bit runs) and the raised field 1 1/2" inside it
    ear_l = arc((2.5, 6.0), (2.72, 5.47), (3.25, 5.25))
    main = arc((3.25, 5.25), (7.5, 3.5), (11.75, 5.25))
    ear_r = arc((11.75, 5.25), (12.28, 5.47), (12.5, 6.0))
    opening = line((2.5, 25.0), (2.5, 6.0))[:-1] + ear_l[:-1] + main[:-1] + ear_r[:-1] + line((12.5, 6.0), (12.5, 25.0))[:-1] + line((12.5, 25.0), (2.5, 25.0))[:-1]
    ux, uy, R = circ3((3.25, 5.25), (7.5, 3.5), (11.75, 5.25))
    r2 = R - 1.5
    yl = uy - math.sqrt(r2 * r2 - (4.0 - ux) ** 2)
    field_arc = arc((4.0, yl), (7.5, uy - r2), (11.0, yl))
    field = line((4.0, 23.5), (4.0, yl))[:-1] + field_arc[:-1] + line((11.0, yl), (11.0, 23.5))[:-1] + line((11.0, 23.5), (4.0, 23.5))[:-1]
    # bevel: shade each strip by how its slope faces the light (upper left)
    pil = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))
    shade = Image.new('L', (W, H), 128)
    sd = ImageDraw.Draw(shade)
    op = opening + [opening[0]]
    L = np.array([-0.6, -0.8])
    for i in range(len(op) - 1):
        a, b = np.array(op[i]), np.array(op[i + 1])
        t = b - a; n = np.array([t[1], -t[0]]); n /= (np.linalg.norm(n) or 1)
        # inward normal: the opening is traced clockwise on screen (y down), inward is to the right of travel
        cpt = np.array([7.5, 15.0])
        if np.dot(cpt - a, n) < 0: n = -n
        # the bevel slopes down toward the frame edge, so its surface faces outward (-n)
        lit = float(np.dot(-n, L))
        v = int(128 + 70 * lit)
        quad = [tuple(a * PPI), tuple(b * PPI), tuple((b + n * 1.5) * PPI), tuple((a + n * 1.5) * PPI)]
        sd.polygon(quad, fill=v)
    mask = Image.new('L', (W, H), 0)
    ImageDraw.Draw(mask).polygon([(x * PPI, y * PPI) for x, y in opening], fill=255)
    fmask = Image.new('L', (W, H), 0)
    ImageDraw.Draw(fmask).polygon([(x * PPI, y * PPI) for x, y in field], fill=255)
    ring = np.asarray(mask, np.float32) / 255 * (1 - np.asarray(fmask, np.float32) / 255)
    k = (np.asarray(shade.filter(ImageFilter.GaussianBlur(2)), np.float32) / 128.0)
    img = img * (1 + (k[..., None] - 1) * ring[..., None])
    # shadow line where the bevel drops into the frame (lower/right sides darker), soft field edge
    edge = Image.new('L', (W, H), 0)
    ImageDraw.Draw(edge).line([(x * PPI, y * PPI) for x, y in op], fill=255, width=3)
    e = np.asarray(edge.filter(ImageFilter.GaussianBlur(1.2)), np.float32) / 255
    img = img * (1 - 0.45 * e[..., None])
    fe = Image.new('L', (W, H), 0)
    ImageDraw.Draw(fe).line([(x * PPI, y * PPI) for x, y in field + [field[0]]], fill=255, width=2)
    f = np.asarray(fe.filter(ImageFilter.GaussianBlur(1.0)), np.float32) / 255
    img = img * (1 + 0.18 * f[..., None])
    # outer edge profile: a light roundover highlight just inside the door edge
    oe = Image.new('L', (W, H), 0)
    ImageDraw.Draw(oe).rectangle([6, 6, W - 7, H - 7], outline=255, width=5)
    o = np.asarray(oe.filter(ImageFilter.GaussianBlur(2)), np.float32) / 255
    img = img * (1 + 0.12 * o[..., None])
    truth = {
        'name': 'cathedral', 'size_in': [DW, DH],
        'features': [
            {'what': 'raised panel: frame opening (profile edge, raised-panel bit)', 'expect_cut': 'profile', 'closed': True, 'pts': opening},
            {'what': 'raised panel: flat field (made by the same bit, not a separate cut)', 'expect_cut': 'skip', 'closed': True, 'pts': field},
        ],
    }
    return np.clip(img, 0, 255).astype(np.uint8), truth

def render_glass():
    W, H = int(DW * PPI), int(DH * PPI)
    img = wood(W, H, (205, 170, 120), True, 2)
    glass = rounded_rect(2.5, 2.5, 12.5, 25.5, 0.5)
    groove = rounded_rect(1.6, 1.6, 13.4, 26.4, 1.25)
    gm = Image.new('L', (W, H), 0)
    ImageDraw.Draw(gm).polygon([(x * PPI, y * PPI) for x, y in glass], fill=255)
    gmask = np.asarray(gm, np.float32)[..., None] / 255
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    g = np.stack([40 + 25 * yy / H, 52 + 20 * yy / H, 62 + 25 * yy / H], -1)
    # reflections: two soft diagonal streaks and a blurry bright window shape
    s1 = np.exp(-((xx - yy * 0.45 - 180) / 60.0) ** 2) * 90
    s2 = np.exp(-((xx - yy * 0.45 - 330) / 25.0) ** 2) * 60
    win = np.zeros((H, W), np.float32)
    win[300:700, 380:620] = 70
    win = np.asarray(Image.fromarray(win.astype(np.uint8)).filter(ImageFilter.GaussianBlur(25)), np.float32)
    g = g + (s1 + s2 + win)[..., None]
    img = img * (1 - gmask) + g * gmask
    # V-groove: dark line with a highlight on one side
    gl = Image.new('L', (W, H), 0)
    ImageDraw.Draw(gl).line([(x * PPI, y * PPI) for x, y in groove + [groove[0]]], fill=255, width=7)
    d = np.asarray(gl.filter(ImageFilter.GaussianBlur(1.5)), np.float32) / 255
    img = img * (1 - 0.5 * d[..., None])
    # glass stop / bead: light line around the glass
    bd = Image.new('L', (W, H), 0)
    ImageDraw.Draw(bd).line([(x * PPI, y * PPI) for x, y in glass + [glass[0]]], fill=255, width=4)
    b = np.asarray(bd.filter(ImageFilter.GaussianBlur(1)), np.float32) / 255
    img = img * (1 + 0.15 * b[..., None])
    truth = {
        'name': 'glass', 'size_in': [DW, DH],
        'features': [
            {'what': 'glass opening (inside cut)', 'expect_cut': 'inside', 'closed': True, 'pts': glass},
            {'what': 'decorative V-groove loop', 'expect_cut': 'groove', 'closed': True, 'pts': groove},
        ],
    }
    return np.clip(img, 0, 255).astype(np.uint8), truth

def photograph(door, dst, bg_seed):
    """Puts the door on a workbench background and shoots it at an angle."""
    H, W = door.shape[:2]
    r = np.random.default_rng(bg_seed)
    FW, FH = W + 600, H + 500
    flat = np.zeros((FH, FW, 3), np.float32) + np.array([88, 92, 98], np.float32)
    flat += r.normal(0, 7, (FH, FW, 1))
    flat[250:250 + H, 300:300 + W] = door
    # soft shadow under the door's right and bottom edges
    flat_img = Image.fromarray(np.clip(flat, 0, 255).astype(np.uint8))
    PW, PH = 1800, 2400
    src = [(300, 250), (300 + W, 250), (300 + W, 250 + H), (300, 250 + H)]
    def solve(a, b):
        A, B = [], []
        for (x, y), (u, v) in zip(a, b):
            A.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.append(u)
            A.append([0, 0, 0, x, y, 1, -v * x, -v * y]); B.append(v)
        h = np.linalg.solve(np.array(A, float), np.array(B, float))
        return np.append(h, 1).reshape(3, 3)
    Hm = solve(src, dst)
    Hi = np.linalg.inv(Hm)
    photo = flat_img.transform((PW, PH), Image.PERSPECTIVE, tuple((Hi / Hi[2, 2]).flatten()[:8]), Image.BICUBIC, fillcolor=(60, 60, 64))
    arr = np.asarray(photo, np.float32)
    yy, xx = np.mgrid[0:PH, 0:PW].astype(np.float32)
    vign = 1 - 0.25 * (((xx - PW / 2) / PW) ** 2 + ((yy - PH / 2) / PH) ** 2) * 2
    light = 1 + 0.10 * (1 - xx / PW) - 0.05 * yy / PH  # brighter on the left, like a window
    arr = arr * (vign * light)[..., None] + r.normal(0, 3.5, arr.shape)
    photo = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.7))
    return photo, [list(map(float, (Hm @ np.array([x, y, 1.0]))[:2] / (Hm @ np.array([x, y, 1.0]))[2])) for x, y in src]

for render, dst, seed in [(render_cathedral, [(330, 300), (1480, 360), (1560, 2150), (260, 2080)], 11),
                          (render_glass, [(260, 330), (1500, 260), (1540, 2120), (300, 2200)], 12)]:
    door, truth = render()
    name = truth['name']
    Image.fromarray(door).save(f'{OUT}/{name}-flat.png')
    photo, corners = photograph(door, dst, seed)
    photo.save(f'{OUT}/{name}.jpg', quality=86)
    truth['door_corners_px'] = corners
    truth['features'] = [{**f, 'pts': [[round(x, 4), round(y, 4)] for x, y in f['pts']]} for f in truth['features']]
    json.dump(truth, open(f'{OUT}/{name}.json', 'w'))
    print(name, 'corners', [[round(v) for v in c] for c in corners])
