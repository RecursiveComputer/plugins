#!/usr/bin/env python3
"""Upscale a generated clip to 1080p locally (free) with an ESRGAN-family model on the GPU.

  upscale.py IN.mp4 OUT.mp4 --model RealESRGAN_x2plus.pth [--from 0.8 --to 2.9] [--res 1920x1080]
             [--mix 0.85]

For models capped below 1080p (HeyGen Video 1: 1344x768). Each frame goes through the model
(spandrel loads Real-ESRGAN/ESRGAN weights; Apple GPU via MPS, else CUDA, else CPU), then is
resized to --res. --mix blends the model's frame with a plain Lanczos upscale (1.0 = model only):
the model invents fine texture per frame, and a little Lanczos keeps gravel and shrubs from
shimmering. Trim to the range the edit uses (--from/--to): it's the slow part. No audio is kept.
Needs torch and spandrel (`uv pip install spandrel`); weights e.g. RealESRGAN_x2plus.pth from
github.com/xinntao/Real-ESRGAN/releases (v0.2.1). Before using the result,
look at a 100% crop over a few consecutive frames for crawling texture.
"""
import argparse, subprocess
import cv2
import numpy as np
import torch
import spandrel

ap = argparse.ArgumentParser()
ap.add_argument('inp'); ap.add_argument('out')
ap.add_argument('--model', required=True)
ap.add_argument('--from', dest='t0', type=float, default=0.0)
ap.add_argument('--to', dest='t1', type=float, default=1e9)
ap.add_argument('--res', default='1920x1080')
ap.add_argument('--mix', type=float, default=0.85)
a = ap.parse_args()
W, H = map(int, a.res.split('x'))
dev = 'mps' if torch.backends.mps.is_available() else 'cuda' if torch.cuda.is_available() else 'cpu'
model = spandrel.ModelLoader().load_from_file(a.model).eval().to(dev)
half = dev != 'cpu' and model.supports_half
if half: model.half()

cap = cv2.VideoCapture(a.inp); fps = cap.get(cv2.CAP_PROP_FPS) or 24
cap.set(cv2.CAP_PROP_POS_FRAMES, int(round(a.t0 * fps)))
n_max = int(round((min(a.t1, cap.get(cv2.CAP_PROP_FRAME_COUNT) / fps) - a.t0) * fps))
ff = subprocess.Popen(['ffmpeg', '-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{W}x{H}', '-r', str(fps),
                       '-i', '-', '-an', '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', a.out], stdin=subprocess.PIPE)
n = 0
with torch.inference_mode():
    while n < n_max:
        ok, f = cap.read()
        if not ok: break
        x = torch.from_numpy(cv2.cvtColor(f, cv2.COLOR_BGR2RGB)).permute(2, 0, 1)[None].float().div(255).to(dev)
        if half: x = x.half()
        y = model(x).clamp(0, 1)[0].permute(1, 2, 0).float().cpu().numpy()
        up = cv2.resize(cv2.cvtColor((y * 255).round().astype(np.uint8), cv2.COLOR_RGB2BGR), (W, H), interpolation=cv2.INTER_AREA)
        if a.mix < 1:
            up = cv2.addWeighted(up, a.mix, cv2.resize(f, (W, H), interpolation=cv2.INTER_LANCZOS4), 1 - a.mix, 0)
        ff.stdin.write(up.tobytes()); n += 1
ff.stdin.close(); ff.wait()
print('wrote', a.out, n, 'frames', f'{n / fps:.2f}s', 'on', dev)
