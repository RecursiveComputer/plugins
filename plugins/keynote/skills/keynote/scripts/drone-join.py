#!/usr/bin/env python3
"""Make a generated drone move land on (or leave from) the plate exactly.

  drone-join.py CLIP.mp4 PLATE.png OUT.mp4 --land | --leave [--ramp 1.2] [--fps 30]

The clip is interpolated to the film rate. For --land, the last frame is aligned to the
plate (feature similarity) and that correction is ramped in over the final `ramp` seconds,
ending with the exact plate so the cut to the plate shot is invisible. --leave ramps the
correction out over the first `ramp` seconds."""
import argparse, subprocess, cv2, numpy as np
ap = argparse.ArgumentParser(); ap.add_argument('clip'); ap.add_argument('plate'); ap.add_argument('out')
g = ap.add_mutually_exclusive_group(required=True); g.add_argument('--land', action='store_true'); g.add_argument('--leave', action='store_true')
ap.add_argument('--ramp', type=float, default=1.2); ap.add_argument('--fps', type=float, default=30)
a = ap.parse_args()
W, H = 1920, 1080
tmp = a.out + '.interp.mp4'
subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', a.clip, '-vf', f'scale={W}:{H}:flags=lanczos,minterpolate=fps={a.fps}:mi_mode=mci:mc_mode=aobmc:vsbmc=1', '-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p', tmp], check=True)
cap = cv2.VideoCapture(tmp); fr = []
while True:
    ok, f = cap.read()
    if not ok: break
    fr.append(f)
plate = cv2.resize(cv2.imread(a.plate), (W, H), interpolation=cv2.INTER_LANCZOS4)
key = fr[-1] if a.land else fr[0]
orb = cv2.ORB_create(5000); bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
k1, d1 = orb.detectAndCompute(cv2.cvtColor(key, cv2.COLOR_BGR2GRAY), None); k2, d2 = orb.detectAndCompute(cv2.cvtColor(plate, cv2.COLOR_BGR2GRAY), None)
m = sorted(bf.match(d1, d2), key=lambda x: x.distance)[:1500]
A, _ = cv2.estimateAffinePartial2D(np.float32([k1[x.queryIdx].pt for x in m]), np.float32([k2[x.trainIdx].pt for x in m]), method=cv2.RANSAC, ransacReprojThreshold=2)
print('join correction: scale %.4f dx %.1f dy %.1f' % (np.hypot(A[0, 0], A[1, 0]), A[0, 2], A[1, 2]))
I = np.float32([[1, 0, 0], [0, 1, 0]])
n = len(fr); rn = int(a.ramp * a.fps)
enc = subprocess.Popen(['ffmpeg', '-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{W}x{H}', '-r', str(a.fps), '-i', '-', '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', a.out], stdin=subprocess.PIPE)
for i, f in enumerate(fr):
    u = (i - (n - rn)) / rn if a.land else 1 - i / rn
    u = float(np.clip(u, 0, 1)); u = u * u * (3 - 2 * u)
    M = I + (A - I) * u
    out = cv2.warpAffine(f, M.astype(np.float32), (W, H), flags=cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REFLECT)
    # Dissolve into the exact plate over the last/first 6 frames (colour and detail match).
    e = 6
    blend = (i - (n - e)) / e if a.land else 1 - i / e
    blend = float(np.clip(blend, 0, 1))
    if blend > 0: out = cv2.addWeighted(out, 1 - blend, plate, blend, 0)
    enc.stdin.write(out.tobytes())
enc.stdin.close(); enc.wait(); print('wrote', a.out, n, 'frames')
