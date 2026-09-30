#!/usr/bin/env python3
"""A still angle of the space → living footage with a camera move (procedural).

  live-plate.py PLATE.png OUT.mp4 [--move push|drift-left|drift-right|rise|hold]
                [--amount 0.04] [--length 6] [--fps 30] [--res 1920x1080]
                [--wind 1.0] [--breath 0.012] [--grain 0.8] [--start 0]

Camera (measured keynote grammar): wides drift or push slowly; the move eases with the
keynote curve (fast attack, long settle) over the whole shot, so any cut lands mid-move.
Parallax is 2.5D: a depth proxy (lower frame nearer, sky farthest; foliage/edges pop)
scales the displacement, so a lateral drift slides the ground against the far wall.
Life: foliage sways with smooth low-frequency noise (masked to green/high-texture areas),
light breathes (±breath exposure, ~9 s period), a soft light band drifts across, and
per-frame film grain matched to the plate's own noise.
"""
import argparse, subprocess
import cv2
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('plate'); ap.add_argument('out')
ap.add_argument('--move', default='push', choices=['push', 'pull', 'drift-left', 'drift-right', 'rise', 'hold'])
ap.add_argument('--amount', type=float, default=0.04, help='push: zoom fraction; drift/rise: fraction of width')
ap.add_argument('--length', type=float, default=6.0)
ap.add_argument('--fps', type=float, default=30)
ap.add_argument('--res', default='1920x1080')
ap.add_argument('--wind', type=float, default=1.0)
ap.add_argument('--breath', type=float, default=0.012)
ap.add_argument('--grain', type=float, default=0.8)
ap.add_argument('--start', type=float, default=0.0, help='offset into the move (s), so shots can open mid-move')
ap.add_argument('--settle', type=float, default=2.4, help='seconds for the camera move to complete; then the camera is locked')
ap.add_argument('--trim', type=float, default=0.1, help='video plates: seconds dropped from the start (generated clips jump in their first frames)')
ap.add_argument('--ref', help='video plates: still the clip is pinned to (default: first kept frame)')
ap.add_argument('--stabilize', action='store_true', help='video plates: pin every frame (off by default; mask-motion.py already pins with one constant transform)')
a = ap.parse_args()
W, H = (int(v) for v in a.res.split('x'))

# A plate is a still, or a generated clip of the locked-off plate (subtle natural motion).
is_video = a.plate.lower().endswith(('.mp4', '.mov', '.webm'))
clip = []
if is_video:
    cap = cv2.VideoCapture(a.plate); vfps = cap.get(cv2.CAP_PROP_FPS) or 24
    k = 0
    while True:
        ok, fr = cap.read()
        if not ok: break
        if k >= int(round(a.trim * vfps)): clip.append(fr)
        k += 1
    ref = cv2.imread(a.ref) if a.ref else clip[0]
    ref = cv2.resize(ref, (clip[0].shape[1], clip[0].shape[0]), interpolation=cv2.INTER_AREA)
    # Pin every frame to the reference with a feature-based similarity transform: generated
    # clips carry a constant canvas offset/zoom plus a few px of wobble.
    if a.stabilize:
        orb = cv2.ORB_create(4000); bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
        kr, dr = orb.detectAndCompute(cv2.cvtColor(ref, cv2.COLOR_BGR2GRAY), None)
        stab = []
        for fr in clip:
            k, d = orb.detectAndCompute(cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY), None)
            m = sorted(bf.match(dr, d), key=lambda x: x.distance)[:800]
            A, _ = cv2.estimateAffinePartial2D(np.float32([k[x.trainIdx].pt for x in m]), np.float32([kr[x.queryIdx].pt for x in m]), method=cv2.RANSAC, ransacReprojThreshold=2)
            stab.append(cv2.warpAffine(fr, A, (fr.shape[1], fr.shape[0]), flags=cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REFLECT))
        clip = stab
    src = clip[0].astype(np.float32) / 255.0
    print(f'video plate: {len(clip)} frames @ {vfps:.2f} fps after {a.trim}s trim', flush=True)
else:
    src = cv2.imread(a.plate).astype(np.float32) / 255.0
# Work at output resolution plus headroom for the move (never upscale more than needed).
head = 1.0 + max(a.amount, 0.02) * 1.6
sh, sw = src.shape[:2]
scale = max(W * head / sw, H * head / sh)
base = cv2.resize(src, (int(sw * scale), int(sh * scale)), interpolation=cv2.INTER_LANCZOS4 if scale > 1 else cv2.INTER_AREA)
BH, BW = base.shape[:2]

# Depth proxy: 0 far … 1 near. Vertical ramp (ground nearer), plus local texture energy.
yy = np.linspace(0, 1, BH, dtype=np.float32)[:, None] * np.ones((1, BW), np.float32)
gray = cv2.cvtColor(base, cv2.COLOR_BGR2GRAY)
tex = cv2.GaussianBlur(np.abs(cv2.Laplacian(gray, cv2.CV_32F)), (0, 0), 6)
tex = tex / (np.percentile(tex, 99) + 1e-6)
sky = ((base[:, :, 0] > base[:, :, 2] + 0.05) & (gray > 0.45)).astype(np.float32)
sky = cv2.GaussianBlur(sky, (0, 0), 12)
depth = np.clip(0.15 + 0.85 * yy ** 1.6 + 0.12 * np.clip(tex, 0, 1) - 0.25 * sky, 0, 1)

# Foliage mask: green-dominant, textured regions (the tree, plants).
b, g, r = base[:, :, 0], base[:, :, 1], base[:, :, 2]
foliage = ((g > r * 0.92) & (g > b * 1.05) & (tex > 0.25)).astype(np.float32)
foliage = cv2.GaussianBlur(foliage, (0, 0), 5) * (1 - sky * 0.8)

# Plate noise level (for matched grain).
# Flat-area noise (texture inflates a global estimate): median absolute deviation, capped.
noise = float(min(0.012, 1.4826 * np.median(np.abs(gray - cv2.GaussianBlur(gray, (0, 0), 1.2)))))
rng = np.random.default_rng(3)


def ease(x):
    # keynoteEase ≈ cubic-bezier(0.4, 0.3, 0.4, 0.9): solve x(t) then y(t).
    lo, hi = 0.0, 1.0
    for _ in range(30):
        t = (lo + hi) / 2
        bx = 3 * (1 - t) ** 2 * t * 0.4 + 3 * (1 - t) * t ** 2 * 0.4 + t ** 3
        lo, hi = (t, hi) if bx < x else (lo, t)
    t = (lo + hi) / 2
    return 3 * (1 - t) ** 2 * t * 0.3 + 3 * (1 - t) * t ** 2 * 0.9 + t ** 3


def smooth_noise(shape, t, freq, seed):
    # Low-frequency animated noise field from summed sines (deterministic, seamless).
    h, w = shape
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    f = np.zeros(shape, np.float32)
    rs = np.random.default_rng(seed)
    for k in range(4):
        kx, ky = rs.uniform(0.6, 1.4, 2) * freq * (k + 1)
        ph = rs.uniform(0, 6.28)
        sp = rs.uniform(0.35, 0.8) * (1 + k * 0.3)
        f += np.sin(xs * kx / w * 6.28 + ys * ky / h * 6.28 + t * sp * 6.28 + ph) / (k + 1)
    return f / 2.0


n = int(round(a.length * a.fps))
total = a.length + a.start
enc = subprocess.Popen(['ffmpeg', '-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{W}x{H}', '-r', str(a.fps), '-i', '-',
                        '-vf', 'scale=out_color_matrix=bt709:out_range=tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
                        '-c:v', 'libx264', '-crf', '14', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', a.out], stdin=subprocess.PIPE)
ys, xs = np.mgrid[0:BH, 0:BW].astype(np.float32)
small = (BH // 8, BW // 8)
for f in range(n):
    t = a.start + f / a.fps
    # Keynote camera: the move eases (fast attack, long settle) and LOCKS at its final
    # position after `settle` seconds; the rest of the shot holds still.
    u = ease(min(1.0, t / max(a.settle, 1e-3)))
    if is_video:
        fr = clip[min(len(clip) - 1, int(round((f / a.fps) * vfps)))].astype(np.float32) / 255.0
        base = cv2.resize(fr, (BW, BH), interpolation=cv2.INTER_LANCZOS4 if scale > 1 else cv2.INTER_AREA)
    # Camera: crop window in base coords, plus depth-scaled lateral parallax.
    zoom = 1.0; dx = 0.0; dy = 0.0
    if a.move == 'push': zoom = 1.0 + a.amount * u
    elif a.move == 'pull': zoom = 1.0 + a.amount * (1 - u)
    elif a.move == 'drift-left': dx = -a.amount * (u - 0.5) * W
    elif a.move == 'drift-right': dx = a.amount * (u - 0.5) * W
    elif a.move == 'rise': dy = -a.amount * (u - 0.5) * H
    if is_video and f == 0:
        pass
    # Displacement field (base px): camera parallax + foliage sway.
    par = depth * 1.0
    mx = xs - dx * scale * (par - 0.5) * 0.6
    my = ys - dy * scale * (par - 0.5) * 0.6
    if a.wind > 0 and not is_video:
        wn = cv2.resize(smooth_noise(small, t, 1.2, 11), (BW, BH), interpolation=cv2.INTER_CUBIC)
        wn2 = cv2.resize(smooth_noise(small, t * 1.3, 1.6, 12), (BW, BH), interpolation=cv2.INTER_CUBIC)
        mx = mx + wn * foliage * 1.6 * a.wind * scale
        my = my + wn2 * foliage * 0.8 * a.wind * scale
    frame = cv2.remap(base, mx.astype(np.float32), my.astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
    # Crop the camera window.
    cw, ch = W * head / zoom / head, H * head / zoom / head
    # Headroom only matters for lateral moves; pushes start from the full plate (zoom 1 = the plate as shot).
    hd = head if a.move in ('drift-left', 'drift-right', 'rise') else 1.0
    cw_b, ch_b = BW / hd / zoom, BH / hd / zoom
    cx = BW / 2 + dx * scale; cy = BH / 2 + dy * scale
    M = np.float32([[W / cw_b, 0, -(cx - cw_b / 2) * W / cw_b], [0, H / ch_b, -(cy - ch_b / 2) * H / ch_b]])
    out = cv2.warpAffine(frame, M, (W, H), flags=cv2.INTER_AREA if W / cw_b < 1 else cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
    # Light: slow exposure breath + a soft band of light drifting across.
    br = 1.0 + a.breath * np.sin(t / 9.0 * 6.28)
    band = np.exp(-((np.linspace(0, 1, W)[None, :] - (0.2 + 0.6 * ((t / 24.0) % 1))) ** 2) / 0.08).astype(np.float32)
    out = out * br * (1 + 0.012 * band[:, :, None])
    # Generated clips carry their own texture; add only a light grain to unify with the stills.
    if a.grain > 0:
        gr = rng.normal(0, max(noise, 0.006) * a.grain * (0.5 if is_video else 1.0), (H // 2, W // 2)).astype(np.float32)
        gr = cv2.resize(gr, (W, H), interpolation=cv2.INTER_LINEAR)
        out = out + gr[:, :, None]
    enc.stdin.write((np.clip(out, 0, 1) * 255).astype(np.uint8).tobytes())
enc.stdin.close(); enc.wait()
print('wrote', a.out, f'{n} frames, move={a.move}, noise={noise:.4f}')
