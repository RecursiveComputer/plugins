#!/usr/bin/env python3
"""Upscale a generated plate (~1664 px wide) to film size with Real-ESRGAN x2 (keynote kit).

  upscale-still.py IN.png OUT.png --model RealESRGAN_x2plus.pth [--width 3840] [--mix 0.8]

Image generators deliver ~1664x936; the comp pushes in up to ~1.2x, so plates want 2x-4x the
frame. The model runs on the Apple GPU (MPS) via spandrel; --mix blends a little Lanczos back
in so stone and gravel keep their real grain instead of invented texture. Same environment as
upscale.py (torch + spandrel).
"""
import argparse
import cv2
import numpy as np
import torch
import spandrel

ap = argparse.ArgumentParser(); ap.add_argument('inp'); ap.add_argument('out'); ap.add_argument('--model', required=True)
ap.add_argument('--width', type=int, default=3840); ap.add_argument('--mix', type=float, default=0.8); ap.add_argument('--tile', type=int, default=512)
a = ap.parse_args()
dev = 'mps' if torch.backends.mps.is_available() else 'cuda' if torch.cuda.is_available() else 'cpu'
model = spandrel.ModelLoader().load_from_file(a.model).eval().to(dev)
img = cv2.imread(a.inp, cv2.IMREAD_COLOR)[:, :, ::-1].astype(np.float32) / 255.0
H, W = img.shape[:2]; S = model.scale; T = a.tile; pad = 16
out = np.zeros((H * S, W * S, 3), np.float32)
with torch.no_grad():
    for y in range(0, H, T):
        for x in range(0, W, T):
            y0, x0 = max(0, y - pad), max(0, x - pad); y1, x1 = min(H, y + T + pad), min(W, x + T + pad)
            t = torch.from_numpy(np.ascontiguousarray(img[y0:y1, x0:x1].transpose(2, 0, 1)))[None].to(dev)
            r = model(t)[0].clamp(0, 1).cpu().numpy().transpose(1, 2, 0)
            oy, ox = (y - y0) * S, (x - x0) * S
            h, w = (min(T, H - y)) * S, (min(T, W - x)) * S
            out[y * S:y * S + h, x * S:x * S + w] = r[oy:oy + h, ox:ox + w]
h2 = round(H * a.width / W)
up = cv2.resize(out, (a.width, h2), interpolation=cv2.INTER_LANCZOS4)
lz = cv2.resize(img, (a.width, h2), interpolation=cv2.INTER_LANCZOS4)
res = np.clip(up * a.mix + lz * (1 - a.mix), 0, 1)
cv2.imwrite(a.out, (res[:, :, ::-1] * 255 + 0.5).astype(np.uint8))
print(a.out, f'{a.width}x{h2}', dev)
