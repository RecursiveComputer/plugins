#!/usr/bin/env python3
"""A 3x UI capture → a clip on flat black: shown at 2x CSS size (sharp), centred, with a slow
push that settles and locks (keynote ease).  ui-clip.py IN.png OUT.mp4 [--length 4] [--push 0.05] [--scale 0.667]"""
import argparse, subprocess, cv2, numpy as np
ap = argparse.ArgumentParser(); ap.add_argument('src'); ap.add_argument('out')
ap.add_argument('--length', type=float, default=4); ap.add_argument('--push', type=float, default=0.05)
ap.add_argument('--scale', type=float, default=2 / 3); ap.add_argument('--settle', type=float, default=2.2); ap.add_argument('--fps', type=float, default=30)
a = ap.parse_args()
W, H = 1920, 1080
img = cv2.imread(a.src, cv2.IMREAD_UNCHANGED).astype(np.float32) / 255.0
if img.shape[2] == 3: img = np.dstack([img, np.ones(img.shape[:2], np.float32)])
def ease(x):
    lo, hi = 0.0, 1.0
    for _ in range(30):
        t = (lo + hi) / 2; bx = 3 * (1 - t) ** 2 * t * 0.4 + 3 * (1 - t) * t ** 2 * 0.4 + t ** 3
        lo, hi = (t, hi) if bx < x else (lo, t)
    t = (lo + hi) / 2; return 3 * (1 - t) ** 2 * t * 0.3 + 3 * (1 - t) * t ** 2 * 0.9 + t ** 3
n = int(round(a.length * a.fps))
enc = subprocess.Popen(['ffmpeg', '-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{W}x{H}', '-r', str(a.fps), '-i', '-', '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', a.out], stdin=subprocess.PIPE)
h, w = img.shape[:2]
for f in range(n):
    z = a.scale * (1 + a.push * ease(min(1, f / a.fps / a.settle)))
    M = np.float32([[z, 0, W / 2 - z * w / 2], [0, z, H / 2 - z * h / 2]])
    lay = cv2.warpAffine(img, M, (W, H), flags=cv2.INTER_AREA if z < 1 else cv2.INTER_CUBIC, borderValue=(0, 0, 0, 0))
    out = lay[:, :, :3] * lay[:, :, 3:4]
    enc.stdin.write((np.clip(out, 0, 1) * 255).astype(np.uint8).tobytes())
enc.stdin.close(); enc.wait(); print('wrote', a.out)
