#!/usr/bin/env python3
"""A 3x isolated UI recording → a 1080p shot with an eased framing move and the drawn cursor.

  reframe.py REC.raw.mp4 OUT.mp4 --key T,X,Y,W[,EASE] [--key ...] [--ease 0.9]
             [--pointer REC.pointer.json] [--start 0] [--length 8] [--pad-start 0]

Keys are CSS px of the recorded viewport (the recorder's dpr is detected from the frame
width vs --css-width): at time T the 16:9 frame shows the box of width W centred on (X, Y).
Between keys the frame eases (keynote curve) over --ease seconds starting at the next key's
T, then locks, so the camera follows the UI as it grows (the pill opens, the frame widens) and
never leaves empty frame. Outside the recording is the recording's own background (black).
--pad-start holds the first frame (lets an action land on its word); --start trims the head.
"""
import argparse, json, subprocess
import cv2
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('rec'); ap.add_argument('out')
ap.add_argument('--key', action='append', required=True)
ap.add_argument('--ease', type=float, default=0.9)
ap.add_argument('--pointer')
ap.add_argument('--start', type=float, default=0.0)
ap.add_argument('--pad-start', type=float, default=0.0)
ap.add_argument('--length', type=float)
ap.add_argument('--css-width', type=float, default=1440)
ap.add_argument('--cursor-from', type=float, help='source seconds at which the drawn cursor fades in (0.2 s), e.g. as it starts to move')
ap.add_argument('--cursor-until', type=float, help='source seconds after which the drawn cursor fades out (0.2 s)')
ap.add_argument('--clip', help='CSS rect x,y,w,h kept from the recording; everything else is black (drops viewport edges and stray chrome)')
ap.add_argument('--fps', type=float, default=30)
a = ap.parse_args()
W, H = 1920, 1080

cap = cv2.VideoCapture(a.rec)
vfps = cap.get(cv2.CAP_PROP_FPS); vw = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); vh = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
nsrc = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
dpr = vw / a.css_width
keys = sorted([tuple(float(v) for v in k.split(',')) for k in a.key])
track = json.load(open(a.pointer)) if a.pointer else []


def ease(x):
    # keynoteEase ≈ cubic-bezier(0.4, 0.3, 0.4, 0.9)
    lo, hi = 0.0, 1.0
    for _ in range(30):
        t = (lo + hi) / 2
        bx = 3 * (1 - t) ** 2 * t * 0.4 + 3 * (1 - t) * t ** 2 * 0.4 + t ** 3
        lo, hi = (t, hi) if bx < x else (lo, t)
    t = (lo + hi) / 2
    return 3 * (1 - t) ** 2 * t * 0.3 + 3 * (1 - t) * t ** 2 * 0.9 + t ** 3


def frame_box(t):
    k0 = keys[0][:4]
    for k in keys[1:]:
        if t < k[0]: break
        u = ease(min(1.0, (t - k[0]) / (k[4] if len(k) > 4 else a.ease)))
        k0 = tuple(k0[i] + (k[i] - k0[i]) * u for i in range(4))
    _, x, y, w = k0
    return x * dpr, y * dpr, w * dpr


def pointer_at(t):
    if not track: return None
    i = min(range(len(track)), key=lambda j: abs(track[j]['t'] - t))
    return track[i]['x'], track[i]['y'], track[i].get('down', False)


# The same arrow the keynote stage draws (viewBox 0 0 26 26), rendered once at 4x.
CUR = 26 * 4
cur = np.zeros((CUR, CUR, 4), np.uint8)
pts = (np.array([[3, 2], [3, 21], [8.2, 16.4], [11.6, 24], [15, 22.5], [11.7, 15], [18.6, 15]]) * 4).astype(np.int32)
cv2.fillPoly(cur, [pts], (255, 255, 255, 255), lineType=cv2.LINE_AA)
cv2.polylines(cur, [pts], True, (255, 255, 255, 255), thickness=7, lineType=cv2.LINE_AA)
inner = np.zeros_like(cur); cv2.fillPoly(inner, [pts], (17, 17, 17, 255), lineType=cv2.LINE_AA)
cur = np.where(inner[:, :, 3:4] > 0, inner, cur)

length = a.length if a.length else (nsrc / vfps - a.start + a.pad_start)
n = int(round(length * a.fps))
enc = subprocess.Popen(['ffmpeg', '-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{W}x{H}', '-r', str(a.fps), '-i', '-',
                        '-c:v', 'libx264', '-crf', '12', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', a.out], stdin=subprocess.PIPE)
frames = []
while True:
    ok, fr = cap.read()
    if not ok: break
    frames.append(fr)
for f in range(n):
    t = max(0.0, f / a.fps - a.pad_start) + a.start
    src = frames[min(len(frames) - 1, int(round(t * vfps)))]
    if a.clip:
        cx_, cy_, cw_, ch_ = (int(float(v) * dpr) for v in a.clip.split(','))
        m = np.zeros_like(src); m[cy_:cy_ + ch_, cx_:cx_ + cw_] = src[cy_:cy_ + ch_, cx_:cx_ + cw_]; src = m
    cx, cy, bw = frame_box(t)
    s = W / bw
    M = np.float32([[s, 0, W / 2 - cx * s], [0, s, H / 2 - cy * s]])
    out = cv2.warpAffine(src, M, (W, H), flags=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC, borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))
    p = pointer_at(t)
    fade = 1.0 if a.cursor_until is None else max(0.0, min(1.0, 1 - (t - a.cursor_until) / 0.2))
    if a.cursor_from is not None: fade *= max(0.0, min(1.0, (t - a.cursor_from) / 0.2))
    if p and fade > 0:
        px, py = p[0] * s + M[0, 2], p[1] * s + M[1, 2]
        size = int(26 * 0.85 * dpr * s * (0.9 if p[2] else 1.0))
        if size > 4:
            c = cv2.resize(cur, (size, size), interpolation=cv2.INTER_AREA)
            x0, y0 = int(px - 3 / 26 * size), int(py - 2 / 26 * size)
            xa, ya, xb, yb = max(0, x0), max(0, y0), min(W, x0 + size), min(H, y0 + size)
            if xb > xa and yb > ya:
                cc = c[ya - y0:yb - y0, xa - x0:xb - x0].astype(np.float32)
                al = cc[:, :, 3:4] / 255.0 * fade
                out[ya:yb, xa:xb] = (out[ya:yb, xa:xb] * (1 - al) + cc[:, :, :3] * al).astype(np.uint8)
    enc.stdin.write(out.tobytes())
enc.stdin.close(); enc.wait()
print('wrote', a.out, f'{n} frames, dpr {dpr:.1f}')
