#!/usr/bin/env python3
"""Cut short generated shots into one sequence of hard cuts (references/transitions.md).

  cut-shots.py OUT.mp4 SHOT [SHOT ...] [--fps 30] [--res 1920x1080] [--grain 0.6]

SHOT is SRC:FROM:TO with optional ,key=value options after the times:
  crop=x0;y0;x1;y1  keep this rectangle (fractions of the frame) before scaling
  reverse           play TO→FROM (a drone-out reversed is a drone-in on the same path)
  ease=out          decelerate to a stop at the end (only the destination settles)
  len=S             output seconds (default: real time, TO−FROM)
  hold=S            hold the last frame this long (grain stays live)

Generated clips are 24 fps; frames between source frames are interpolated with optical flow
(DIS), so real-time playback stays smooth at 30 fps and slowed or eased shots don't stutter.
Use the middle of each generated clip (after the model's ease-in, before it drifts or invents)
and cut on motion. Example (intro: geography → approach → the settle on the hero plate):
  cut-shots.py in.mp4 S1.mp4:1.0:4.5 "S2.mp4:0.8:2.9,crop=0;0;0.95;0.95" C0-drift.mp4:0:2.6
"""
import argparse, math, subprocess, sys
import cv2
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('out'); ap.add_argument('shots', nargs='+')
ap.add_argument('--fps', type=float, default=30)
ap.add_argument('--res', default='1920x1080')
ap.add_argument('--grain', type=float, default=0.6, help='per-frame grain sigma in 8-bit levels (0 = off)')
a = ap.parse_args()
W, H = map(int, a.res.split('x'))
dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
rng = np.random.default_rng(7)


def parse(spec):
    head, *opts = spec.split(',')
    src, t0, t1 = head.rsplit(':', 2)
    o = {}
    for kv in opts:
        k, _, v = kv.partition('=')
        o[k] = v if v else True
    return src, float(t0), float(t1), o


def load(src, t0, t1, crop):
    cap = cv2.VideoCapture(src); fps = cap.get(cv2.CAP_PROP_FPS) or 24
    first = max(0, int(math.floor(t0 * fps)) - 1)
    cap.set(cv2.CAP_PROP_POS_FRAMES, first); frames = []
    while len(frames) < int(math.ceil((t1 - t0) * fps)) + 3:
        ok, f = cap.read()
        if not ok: break
        if crop:
            x0, y0, x1, y1 = map(float, crop.split(';')); h, w = f.shape[:2]
            f = f[int(y0 * h):int(y1 * h), int(x0 * w):int(x1 * w)]
        frames.append(cv2.resize(f, (W, H), interpolation=cv2.INTER_AREA if f.shape[1] > W else cv2.INTER_CUBIC))
    if len(frames) < 2: sys.exit(f'{src}: no frames between {t0} and {t1} s (unreadable or too short)')
    return frames, fps, first, true_times(frames, fps, first)


def true_times(frames, fps, first):
    # Generated clips can be delivered with dropped frames (H3 Max: rendered at 30 fps, delivered
    # at 24 by dropping every 5th, so every 4th step moves twice as far and the move hitches).
    # Measure each step's motion; when a steady share of steps is ~2x the median, give those steps
    # two time units, so in-betweens land at the frames' true times.
    small = [cv2.cvtColor(cv2.resize(f, (320, 180)), cv2.COLOR_BGR2GRAY) for f in frames]
    mag = np.array([np.median(np.linalg.norm(dis.calc(small[i], small[i + 1], None), axis=2)) for i in range(len(small) - 1)])
    units = np.ones(len(mag))
    if len(mag) >= 5 and np.median(mag) > 0.15:
        # Compare each step with its neighbours: the move may be accelerating, so a global median
        # misses the doubled steps where it is still slow.
        nb = (np.r_[mag[1], mag[:-1]] + np.r_[mag[1:], mag[-2]]) / 2
        doubled = mag > 1.4 * np.maximum(nb, 1e-6)
        if 0.12 <= doubled.mean() <= 0.35: units[doubled] = 2
    t = np.concatenate([[0], np.cumsum(units)])
    return first / fps + t * ((len(frames) - 1) / fps / t[-1])


def between(f0, f1, u):
    # Flow-based in-between at fraction u: warp both neighbours toward the time, blend.
    if u < 1e-3: return f0
    if u > 1 - 1e-3: return f1
    g0, g1 = (cv2.cvtColor(cv2.resize(f, (W // 2, H // 2)), cv2.COLOR_BGR2GRAY) for f in (f0, f1))
    fl01 = cv2.resize(dis.calc(g0, g1, None), (W, H)) * 2; fl10 = cv2.resize(dis.calc(g1, g0, None), (W, H)) * 2
    # Flows from time u back to each neighbour (Super SloMo's linear approximation).
    ft0 = -(1 - u) * u * fl01 + u * u * fl10
    ft1 = (1 - u) * (1 - u) * fl01 - u * (1 - u) * fl10
    gx, gy = np.meshgrid(np.arange(W, dtype=np.float32), np.arange(H, dtype=np.float32))
    w0 = cv2.remap(f0, gx + ft0[..., 0], gy + ft0[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    w1 = cv2.remap(f1, gx + ft1[..., 0], gy + ft1[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    return cv2.addWeighted(w0, 1 - u, w1, u, 0)


ff = subprocess.Popen(['ffmpeg', '-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{W}x{H}',
                       '-r', str(a.fps), '-i', '-', '-an', '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', a.out],
                      stdin=subprocess.PIPE)
total = 0
for spec in a.shots:
    src, t0, t1, o = parse(spec)
    frames, fps, first, times = load(src, t0, t1, o.get('crop'))
    L = float(o.get('len', abs(t1 - t0))); n = max(1, int(round(L * a.fps)))
    for i in range(n):
        u = i / max(1, n - 1)
        if o.get('ease') == 'out': u = math.sin(u * math.pi / 2)
        s = (t1 - (t1 - t0) * u) if o.get('reverse') else (t0 + (t1 - t0) * u)
        s = min(max(s, times[0]), times[-1]); k = int(min(np.searchsorted(times, s, side='right') - 1, len(frames) - 2))
        f = between(frames[k], frames[k + 1], float((s - times[k]) / (times[k + 1] - times[k])))
        if a.grain: f = np.clip(f + rng.normal(0, a.grain, f.shape), 0, 255).astype(np.uint8)
        ff.stdin.write(f.tobytes())
    last = f
    for _ in range(int(round(float(o.get('hold', 0)) * a.fps))):
        g = np.clip(last + rng.normal(0, a.grain, last.shape), 0, 255).astype(np.uint8) if a.grain else last
        ff.stdin.write(g.tobytes()); n += 1
    total += n
    print(f'{src}: {t0}–{t1}s → {n / a.fps:.2f}s', flush=True)
ff.stdin.close(); ff.wait()
print('wrote', a.out, f'{total / a.fps:.2f}s')
