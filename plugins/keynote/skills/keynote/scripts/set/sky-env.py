#!/usr/bin/env python3
"""Sky dome from a painted panorama: keep its sky, extend it down past the horizon.

  sky-env.py BLOCKOUT_DIR PANO.png OUT.jpg [--width 2048]

The sky is an environment behind everything (the renderer's background), not splats: no station
sees the low sky behind walls, and a dome never shows holes or parallax errors. Non-sky pixels
(from the blockout's object ids) are replaced column by column with the sky colour just above
the horizon, softened. Pair with `bake.py --no-sky`.
"""
import argparse, os
os.environ.setdefault('OPENCV_IO_ENABLE_OPENEXR', '1')
import cv2, numpy as np
ap = argparse.ArgumentParser(); ap.add_argument('blockout'); ap.add_argument('pano'); ap.add_argument('out'); ap.add_argument('--width', type=int, default=2048)
a = ap.parse_args(); W = a.width; H = W // 2
img = cv2.resize(cv2.imread(a.pano), (W, H), interpolation=cv2.INTER_AREA).astype(np.float32)
idx = cv2.imread(os.path.join(a.blockout, 'pano-index.exr'), cv2.IMREAD_UNCHANGED); idx = idx[..., 0] if idx.ndim == 3 else idx
sky = cv2.resize((np.round(idx) == 0).astype(np.uint8), (W, H), interpolation=cv2.INTER_NEAREST).astype(bool)
sky = cv2.erode(sky.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)  # stay clear of painted wall tops
out = img.copy()
for x in range(W):
    col = sky[:, x]; ys = np.nonzero(col)[0]
    last = ys[ys < H // 2].max() if (ys < H // 2).any() else 0
    base = img[max(0, last - 6):last + 1, x].mean(0) if last > 0 else img[0, x]
    out[last + 1:, x] = base
out = np.where(sky[..., None], img, out)
low = cv2.GaussianBlur(out, (0, 0), 6); out = np.where(sky[..., None], out, low)
cv2.imwrite(a.out, np.clip(out, 0, 255).astype(np.uint8)); print('wrote', a.out)
