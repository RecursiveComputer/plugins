#!/usr/bin/env python3
"""An element (a tree, a plant, a prop) generated on pure white → a trimmed RGBA card.

  key-element.py IN.png OUT.png [--threshold 238]

Thin organic things (trees) never project well onto a blockout: painted onto ground or walls
they smear from any other angle. Generate them isolated on white, key, and stand them in the set as
camera-facing cards (render-splat.mjs `sprites`), with clean plates underneath.
"""
import argparse, cv2, numpy as np
ap = argparse.ArgumentParser(); ap.add_argument('src'); ap.add_argument('out'); ap.add_argument('--threshold', type=int, default=238)
a = ap.parse_args()
img = cv2.imread(a.src).astype(np.float32)
# distance from white, soft ramp; background connected to the border only
d = 255 - img.min(axis=2)
alpha = np.clip((d - (255 - a.threshold)) / 20.0, 0, 1)
bg = (alpha < 0.02).astype(np.uint8)
n, lab = cv2.connectedComponents(bg)
border = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]])))
isbg = np.isin(lab, [l for l in border if l != 0] + ([0] if 0 in border and bg[0, 0] else []))
alpha = np.where(isbg, 0, alpha)
alpha = cv2.GaussianBlur(alpha, (0, 0), 0.7)
# un-premultiply the white fringe
rgb = np.where(alpha[..., None] > 0.05, (img - 255 * (1 - alpha[..., None])) / np.maximum(alpha[..., None], 0.05), img)
ys, xs = np.nonzero(alpha > 0.02)
y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
out = np.dstack([np.clip(rgb, 0, 255), alpha * 255])[y0:y1, x0:x1].astype(np.uint8)
cv2.imwrite(a.out, out); print('wrote', a.out, out.shape[1], 'x', out.shape[0], 'aspect', round(out.shape[1] / out.shape[0], 3))
