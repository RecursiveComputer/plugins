#!/usr/bin/env python3
"""Check (and fix) that an edited plate still lines up with its source (keynote kit).

  align.py SOURCE.png EDITED.png [--fix OUT.png]

Edits like "the same photograph with the wall switched off" must stay pixel-registered with the
source, or the power-on reveal ghosts. Prints the phase-correlation shift; > 0.5 px fails unless
--fix writes a shifted copy. Different sizes are resized to the source first.
"""
import argparse, json, sys
import cv2
import numpy as np

ap = argparse.ArgumentParser(); ap.add_argument('src'); ap.add_argument('edit'); ap.add_argument('--fix')
a = ap.parse_args()
s = cv2.imread(a.src); e = cv2.imread(a.edit)
if e.shape[:2] != s.shape[:2]: e = cv2.resize(e, (s.shape[1], s.shape[0]), interpolation=cv2.INTER_LANCZOS4)
gs, ge = (cv2.cvtColor(i, cv2.COLOR_BGR2GRAY).astype(np.float32) for i in (s, e))
(dx, dy), resp = cv2.phaseCorrelate(gs, ge)
ok = abs(dx) <= 0.5 and abs(dy) <= 0.5
print(json.dumps({'dx': round(dx, 2), 'dy': round(dy, 2), 'response': round(resp, 3), 'ok': ok}))
if a.fix:
    M = np.float32([[1, 0, -dx], [0, 1, -dy]])
    cv2.imwrite(a.fix, cv2.warpAffine(e, M, (s.shape[1], s.shape[0]), flags=cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REFLECT))
sys.exit(0 if ok or a.fix else 1)
