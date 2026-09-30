#!/usr/bin/env python3
"""Frequency-split grade: keep a sharp painting's detail, take colour and light from a reference.

  grade.py SHARP.png REF.png OUT.png [--radius 0.02]

Every station painted after the first is graded to what the set already looks like from that
camera (REF = a render of the existing splat): OUT = SHARP - blur(SHARP) + blur(REF). Broad colour,
exposure and shadow placement come from REF (so stations match), fine detail from SHARP.
"""
import argparse, cv2, numpy as np
ap = argparse.ArgumentParser(); ap.add_argument('sharp'); ap.add_argument('ref'); ap.add_argument('out')
ap.add_argument('--radius', type=float, default=0.02, help='blur sigma as a fraction of the image width')
a = ap.parse_args()
s = cv2.imread(a.sharp).astype(np.float32)
r = cv2.resize(cv2.imread(a.ref), (s.shape[1], s.shape[0]), interpolation=cv2.INTER_CUBIC).astype(np.float32)
sig = a.radius * s.shape[1]
out = s - cv2.GaussianBlur(s, (0, 0), sig) + cv2.GaussianBlur(r, (0, 0), sig)
cv2.imwrite(a.out, np.clip(out, 0, 255).astype(np.uint8)); print('wrote', a.out)
