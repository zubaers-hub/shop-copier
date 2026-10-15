"""Draws found shapes over an image. Usage: python3 details_overlay.py image.png found.json out.png"""
import json, sys
from PIL import Image, ImageDraw
COL = {'outside': (255, 107, 0), 'inside': (229, 57, 53), 'pocket': (30, 136, 229), 'groove': (46, 158, 68), 'profile': (156, 39, 176), 'skip': (158, 158, 158)}
im = Image.open(sys.argv[1]).convert('RGB'); d = ImageDraw.Draw(im)
for s in json.load(open(sys.argv[2]))['shapes']:
    pts = [tuple(p) for p in s['pts']]
    if s['closed']: pts.append(pts[0])
    d.line(pts, fill=COL[s['guess']['cut']], width=4)
im.save(sys.argv[3])
