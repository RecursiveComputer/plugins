#!/usr/bin/env python3
"""Find the LED wall's face in a wall-on plate (keynote kit): the largest near-white region.

  wall-rect.py PLATE.png [--min 232] [--inset 2]   → prints {"x","y","w","h"} (plate pixels)

The face is the brightest large connected region; the rect is inset a little so composited
content stays inside the plate's own bezel. Check the result on a still before rendering.
"""
import argparse, json
import cv2
import numpy as np

ap = argparse.ArgumentParser(); ap.add_argument('plate'); ap.add_argument('--min', type=int, default=232); ap.add_argument('--inset', type=int, default=2)
a = ap.parse_args()
g = cv2.cvtColor(cv2.imread(a.plate), cv2.COLOR_BGR2GRAY)
m = cv2.morphologyEx((g >= a.min).astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
n, lab, st, _ = cv2.connectedComponentsWithStats(m)
if n < 2: raise SystemExit('no bright region found; lower --min')
# prefer large, rectangular, wide regions (the face), not a bright sky or reflection streak
best = max(range(1, n), key=lambda i: st[i][4] * (st[i][4] / (st[i][2] * st[i][3])) * (1 if st[i][2] > st[i][3] else 0.3))
x, y, w, h, area = (int(v) for v in st[best])
i = a.inset
print(json.dumps({'x': x + i, 'y': y + i, 'w': w - 2 * i, 'h': h - 2 * i, 'fill': round(area / (w * h), 3)}))
