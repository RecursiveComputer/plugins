#!/usr/bin/env python3
"""Build the film's bookends: drone lands → the wall powers on; the wall powers off → drone leaves.

  bookend.py open  DRONE_IN.mp4  PLATE.png CONTENT.jpg BG.mp4 OUT.mp4
  bookend.py close DRONE_OUT.mp4 PLATE.png CONTENT.jpg BG.mp4 OUT.mp4 --off X

DRONE_* are drone-join.py outputs (landing on / leaving from PLATE exactly). CONTENT is the wall
still (1920x1080; white = the blank panel). BG is the pinned, masked motion clip of PLATE
(mask-motion.py) that plays behind the wall.

open:  the wall content fades up from blank (0.35 s hold, 1.1 s fade) in a composite of the
       plate; the drone's last 0.4 s dissolves into it. In the film, cut the flight shot and the
       wall shot from this one clip (`flight: true` on the first; `from` on the second) and set
       the act's `scriptAt` just after the wall has powered on, so the music plays alone first.
close: the content holds until X (the act's last word), powers off to blank over 0.8 s, and
       dissolves (0.4 s) into the drone leaving. Cut the wall shot and the flight from this clip.
"""
import argparse, os, subprocess, sys, tempfile
import cv2
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('mode', choices=['open', 'close']); ap.add_argument('drone'); ap.add_argument('plate')
ap.add_argument('content'); ap.add_argument('bg'); ap.add_argument('out')
ap.add_argument('--off', type=float, default=4.0, help='close: seconds the content holds before powering off')
ap.add_argument('--wall-args', default='--neutral 0.8 --content-zoom 1.7 --face-aspect 1.778 --wind 0 --grain 0')
a = ap.parse_args()
here = os.path.dirname(os.path.abspath(__file__))
tmp = tempfile.mkdtemp(prefix='bookend-')
frames = os.path.join(tmp, 'c'); os.makedirs(frames)
on = cv2.imread(a.content).astype(np.float32); white = np.full_like(on, 255)
smooth = lambda u: u * u * (3 - 2 * u)
if a.mode == 'open':
    length, n = 11.5, int(1.45 * 30) + 1
    u_of = lambda t: smooth(min(1, max(0, (t - 0.35) / 1.1)))
else:
    length = a.off + 1.3; n = int(round(length * 30))
    u_of = lambda t: 1 - smooth(min(1, max(0, (t - a.off) / 0.8)))
for i in range(n):
    u = u_of(i / 30)
    cv2.imwrite(os.path.join(frames, f'{i + 1:05d}.jpg'), (white * (1 - u) + on * u).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 96])
wall_dir = os.path.join(tmp, 's')
subprocess.run([sys.executable, os.path.join(here, 'composite-plate.py'), a.plate, frames, wall_dir, '--length', str(length), '--bg-video', a.bg, *a.wall_args.split()], check=True, stdout=subprocess.DEVNULL)
wall = os.path.join(tmp, 'wall.mp4')
subprocess.run(['ffmpeg', '-y', '-v', 'error', '-framerate', '30', '-i', os.path.join(wall_dir, '%05d.jpg'), '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', wall], check=True)
dur = lambda p: float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p], capture_output=True, text=True).stdout)
first, second, offset = (a.drone, wall, dur(a.drone) - 0.4) if a.mode == 'open' else (wall, a.drone, a.off + 0.8)
subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', first, '-i', second, '-filter_complex',
                f'[0]fps=30,format=yuv420p,setsar=1[a];[1]fps=30,format=yuv420p,setsar=1[b];[a][b]xfade=transition=fade:duration=0.4:offset={offset:.3f}',
                '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', a.out], check=True)
print('wrote', a.out, f'{dur(a.out):.2f}s', f'(open: the wall is lit by {offset + 0.4 + 1.45:.2f}s)' if a.mode == 'open' else f'(close: power-off at {a.off}s, drone from {offset:.2f}s)')
