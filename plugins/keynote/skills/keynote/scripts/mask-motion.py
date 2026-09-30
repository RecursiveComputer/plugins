#!/usr/bin/env python3
"""Pin a generated motion clip to its plate, optionally keeping motion only inside regions.

  mask-motion.py PLATE.png CLIP.mp4 OUT.mp4 [--rect x0,y0,x1,y1 ...] [--feather 0.03]
                 [--trim 0.1] [--fps 30] [--length S]

Every clip frame is aligned to the still plate (ORB + RANSAC similarity), so the output
matches the plate pixel for pixel. With --rect (fractions of the frame), motion is kept
only inside those feathered regions and the rest stays the still plate: use it where
the video model invents things (new foreground foliage, a panel that changes).
Output is at the plate's resolution; frames beyond the clip hold the last frame.
"""
import argparse, subprocess
import cv2
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('plate'); ap.add_argument('clip'); ap.add_argument('out')
ap.add_argument('--rect', action='append', default=[])
ap.add_argument('--feather', type=float, default=0.03)
ap.add_argument('--trim', type=float, default=0.1)
ap.add_argument('--fps', type=float, default=30)
ap.add_argument('--length', type=float)
ap.add_argument('--res', default='1920x1080', help='output size (the plate is scaled to it; generated clips are native 1080p)')
a = ap.parse_args()

W, H = (int(v) for v in a.res.split('x'))
plate = cv2.resize(cv2.imread(a.plate), (W, H), interpolation=cv2.INTER_LANCZOS4)
src_clip = a.clip
cap0 = cv2.VideoCapture(a.clip); src_fps = cap0.get(cv2.CAP_PROP_FPS) or 24; cap0.release()
if abs(src_fps - a.fps) > 0.01:
    # Motion-compensated interpolation to the film rate (no duplicated frames = no judder).
    src_clip = a.out + '.interp.mp4'
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', a.clip, '-vf', f"minterpolate=fps={a.fps}:mi_mode=mci:mc_mode=aobmc:vsbmc=1",
                    '-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p', src_clip], check=True)
cap = cv2.VideoCapture(src_clip); vfps = cap.get(cv2.CAP_PROP_FPS) or a.fps
frames = []
k = 0
while True:
    ok, f = cap.read()
    if not ok: break
    if k >= int(round(a.trim * vfps)): frames.append(cv2.resize(f, (W, H), interpolation=cv2.INTER_LANCZOS4))
    k += 1

# One constant transform for the whole clip: the model's canvas offset/zoom is fixed, and
# the clip itself is steady. Re-fitting every frame (features on moving leaves) ADDS
# jitter, so estimate on several frames, take the median, and apply it to all.
orb = cv2.ORB_create(5000); bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
kr, dr = orb.detectAndCompute(cv2.cvtColor(plate, cv2.COLOR_BGR2GRAY), None)
ests = []
for fr in frames[:: max(1, len(frames) // 8)]:
    kf, df = orb.detectAndCompute(cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY), None)
    m = sorted(bf.match(dr, df), key=lambda x: x.distance)[:1000]
    A, _ = cv2.estimateAffinePartial2D(np.float32([kf[x.trainIdx].pt for x in m]), np.float32([kr[x.queryIdx].pt for x in m]), method=cv2.RANSAC, ransacReprojThreshold=2)
    if A is not None: ests.append(A)
A_fix = np.median(np.stack(ests), axis=0)
print('constant pin: scale %.4f dx %.2f dy %.2f' % (np.hypot(A_fix[0, 0], A_fix[1, 0]), A_fix[0, 2], A_fix[1, 2]))

mask = None
if a.rect:
    mask = np.zeros((H, W), np.float32)
    for r in a.rect:
        x0, y0, x1, y1 = (float(v) for v in r.split(','))
        mask[int(y0 * H):int(y1 * H), int(x0 * W):int(x1 * W)] = 1
    mask = cv2.GaussianBlur(mask, (0, 0), a.feather * W)[:, :, None]

length = a.length or len(frames) / vfps
n = int(round(length * a.fps))
enc = subprocess.Popen(['ffmpeg', '-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{W}x{H}', '-r', str(a.fps), '-i', '-',
                        '-c:v', 'libx264', '-crf', '12', '-preset', 'medium', '-pix_fmt', 'yuv420p', a.out], stdin=subprocess.PIPE)
if n > len(frames) * a.fps / vfps + 1:
    print(f'warning: {length:.1f}s requested but the clip has {len(frames) / vfps:.1f}s; generate a longer clip (held frames read as a freeze)')
for i in range(n):
    # Clip frames were interpolated to the output rate (see --interp); index 1:1.
    j = min(len(frames) - 1, int(round(i / a.fps * vfps)))
    al = cv2.warpAffine(frames[j], A_fix, (W, H), flags=cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REFLECT)
    if mask is not None:
        al = (al.astype(np.float32) * mask + plate.astype(np.float32) * (1 - mask)).astype(np.uint8)
    enc.stdin.write(al.tobytes())
enc.stdin.close(); enc.wait()
print('wrote', a.out, f'{n} frames at {W}x{H}')
