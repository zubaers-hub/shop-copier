"""Makes a fake phone photo for the end-to-end test: a dark corbel (6" x 10", symmetric, with a 1" hole)
and a letter-size sheet of paper (8 1/2" x 11") on a light wall, shot at an angle (perspective), with noise and
JPEG compression. Writes photo.jpg and truth.json (paper corners and a point inside the corbel, in photo pixels)."""
import json, math, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

out = sys.argv[1] if len(sys.argv) > 1 else "tests/out"
PPI = 60  # pixels per inch on the flat "wall"
W_IN, H_IN = 30, 20
flat = Image.new("RGB", (W_IN * PPI, H_IN * PPI), (214, 208, 196))
d = ImageDraw.Draw(flat)
# subtle wall texture
rng = np.random.default_rng(7)
tex = (rng.normal(0, 6, (H_IN * PPI, W_IN * PPI, 1)).repeat(3, 2)).astype(np.int16)
flat = Image.fromarray(np.clip(np.asarray(flat, dtype=np.int16) + tex, 0, 255).astype(np.uint8))
d = ImageDraw.Draw(flat)

paper_origin = (2.0, 4.0)
px = lambda x, y: ((paper_origin[0] + x) * PPI, (paper_origin[1] + y) * PPI)
d.rectangle([px(0, 0), px(8.5, 11)], fill=(250, 250, 247))

from make_photo_shapes import arc_pts, corbel_outline

CX, CY = 14.0, 3.0
poly = [((CX + x) * PPI, (CY + y) * PPI) for (x, y) in corbel_outline()]
d.polygon(poly, fill=(92, 58, 30))
hole = [((CX + 3 + 0.5 * math.cos(t)) * PPI, (CY + 2.5 + 0.5 * math.sin(t)) * PPI) for t in np.linspace(0, 2 * math.pi, 90)]
d.polygon(hole, fill=(214, 208, 196))
flat = flat.filter(ImageFilter.GaussianBlur(1.2))

# perspective: where the wall's corners land in the photo (camera off to the left and a bit low)
PW, PH = 2000, 1500
src = [(0, 0), (W_IN * PPI, 0), (W_IN * PPI, H_IN * PPI), (0, H_IN * PPI)]
dst = [(140, 90), (1880, 230), (1800, 1350), (230, 1440)]
def solve_h(a, b):
    A, B = [], []
    for (x, y), (u, v) in zip(a, b):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.append(u)
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y]); B.append(v)
    h = np.linalg.solve(np.array(A, float), np.array(B, float))
    return np.append(h, 1).reshape(3, 3)
Hm = solve_h(src, dst)  # wall px -> photo px
Hinv = np.linalg.inv(Hm)
coeffs = (Hinv / Hinv[2, 2]).flatten()[:8]  # PIL wants photo -> wall
photo = flat.transform((PW, PH), Image.PERSPECTIVE, tuple(coeffs), Image.BICUBIC, fillcolor=(40, 40, 40))
noise = rng.normal(0, 4, (PH, PW, 1)).repeat(3, 2)
photo = Image.fromarray(np.clip(np.asarray(photo, dtype=np.float32) + noise, 0, 255).astype(np.uint8))
photo.save(f"{out}/photo.jpg", quality=85)

def to_photo(x_in, y_in):
    v = Hm @ np.array([x_in * PPI, y_in * PPI, 1.0])
    return [float(v[0] / v[2]), float(v[1] / v[2])]
truth = {
    "paper_corners_px": [to_photo(paper_origin[0] + x, paper_origin[1] + y) for x, y in [(0, 0), (8.5, 0), (8.5, 11), (0, 11)]],
    "corbel_inside_px": to_photo(CX + 3, CY + 7),
    "corbel_inside_in_rect": [CX + 3 - paper_origin[0], CY + 7 - paper_origin[1]],
    "corbel_size_in": [6, 10],
    "paper_in": [8.5, 11],
}
json.dump(truth, open(f"{out}/truth.json", "w"), indent=2)
print(json.dumps(truth))
