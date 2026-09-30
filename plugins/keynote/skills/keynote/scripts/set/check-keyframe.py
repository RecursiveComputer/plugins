#!/usr/bin/env python3
"""Check that a painted keyframe matches its camera's blockout (spatially correct from its angle).

  check-keyframe.py KEY.png BLOCKOUT_DIR [--out overlay.jpg] [--json result.json]

BLOCKOUT_DIR is blockout.py's output for the keyframe's camera (persp-clay.png, persp-index.exr,
camera.json). The painting is measured against the camera exactly as it is, relative to the clay
render measured the same way (1.0 = as well as the geometry itself):
  edges  share of the architecture's outline (walls, roofs, glass, the LED wall, columns, steel;
         not plants; only outlines the clay render shows) within 4 px of a painted edge. Edges come
         from a texture-suppressed image, so gravel and shrubs don't count as architecture.
  led    IoU of the blockout's LED rectangle with the flat bright panel painted there (skipped when
         the LED is too small to measure)
  fit    advice for a failure: the shift/scale that best lays the outline onto the painting
         (a zoomed or shifted painting: regenerate, or fit the camera to an already approved plate)
Writes an overlay: the camera's outline in cyan, the best fit in magenta. Look at it before approving.
PASS needs edges >= 0.7 and led >= 0.8 (calibrated: approved paintings 0.76-0.90; another viewpoint
0.42-0.52). A keyframe that fails is regenerated before any video is generated from it.
"""
import argparse, json, os
os.environ['OPENCV_IO_ENABLE_OPENEXR'] = '1'
import cv2
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('key'); ap.add_argument('blockout')
ap.add_argument('--out'); ap.add_argument('--json')
a = ap.parse_args()

W, H = 1920, 1080
TOL = 4
load = lambda p: cv2.resize(cv2.imread(p), (W, H), interpolation=cv2.INTER_AREA)
key, clay = load(a.key), load(os.path.join(a.blockout, 'persp-clay.png'))
kinds = json.load(open(os.path.join(a.blockout, 'camera.json')))['kinds']
idx = cv2.imread(os.path.join(a.blockout, 'persp-index.exr'), cv2.IMREAD_UNCHANGED)
if idx.ndim == 3: idx = idx[..., 0]
idx = cv2.resize(np.rint(idx).astype(np.uint8), (W, H), interpolation=cv2.INTER_NEAREST)


def edges_of(img):
    # Architecture edges survive a median filter at half size; gravel, shrub and grain texture don't.
    g = cv2.medianBlur(cv2.cvtColor(cv2.resize(img, (W // 2, H // 2), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY), 5)
    e = cv2.Canny(g, 25, 70)
    return cv2.resize(e, (W, H), interpolation=cv2.INTER_NEAREST) > 0


arch = [kinds[k] for k in ('wall', 'roof', 'led', 'glass', 'column', 'steel') if k in kinds]
plants = [kinds[k] for k in ('shrub', 'canopy', 'trunk') if k in kinds]
outline = np.zeros((H, W), bool)
for dy, dx in ((0, 1), (1, 0)):
    p, q = idx[:H - dy, :W - dx], idx[dy:, dx:]
    outline[:H - dy, :W - dx] |= (p != q) & (np.isin(p, arch) | np.isin(q, arch)) & ~np.isin(p, plants) & ~np.isin(q, plants)
outline &= cv2.dilate(edges_of(clay).astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
ys, xs = np.nonzero(outline)
if len(xs) < 50: raise SystemExit('no visible architecture in this blockout view')


def cover(img):
    dist = cv2.distanceTransform((~edges_of(img)).astype(np.uint8), cv2.DIST_L2, 5)
    d = dist[ys, xs]
    return float(np.mean(d <= TOL)), d


def led_iou(img):
    if 'led' not in kinds: return None
    m = (idx == kinds['led']).astype(np.uint8)
    x, y, w, h = cv2.boundingRect(m)
    if w * h < 1500: return None
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV); v = hsv[..., 2].astype(np.float32)
    mu = cv2.blur(v, (7, 7)); sd = np.sqrt(np.maximum(cv2.blur(v * v, (7, 7)) - mu * mu, 0))
    X0, Y0, X1, Y1 = int(max(0, x - 0.3 * w)), int(max(0, y - 0.3 * h)), int(min(W, x + 1.3 * w)), int(min(H, y + 1.3 * h))
    win = v[Y0:Y1, X0:X1]
    flat = ((win > 0.9 * np.percentile(win, 95)) & (hsv[Y0:Y1, X0:X1, 1] < 50) & (sd[Y0:Y1, X0:X1] < 7)).astype(np.uint8)
    n, _, st, _ = cv2.connectedComponentsWithStats(flat)
    if n < 2: return 0.0
    i = 1 + int(np.argmax(st[1:, 4])); bx, by, bw, bh = st[i, :4]
    bx, by, bw, bh = bx + X0 - 3, by + Y0 - 3, bw + 6, bh + 6  # the flatness test erodes ~3 px
    ix = max(0, min(x + w, bx + bw) - max(x, bx)); iy = max(0, min(y + h, by + bh) - max(y, by))
    return float(ix * iy / (w * h + bw * bh - ix * iy))


self_cover = cover(clay)[0]; key_cover, d = cover(key)
self_led, key_led = led_iou(clay), led_iou(key)

# Advice: the best shift/scale of the outline onto the painting (coarse to fine).
dist = cv2.distanceTransform((~edges_of(key)).astype(np.uint8), cv2.DIST_L2, 5)
def fit_cost(s, tx, ty):
    u = np.clip(((xs - W / 2) * s + W / 2 + tx).astype(int), 0, W - 1); v = np.clip(((ys - H / 2) * s + H / 2 + ty).astype(int), 0, H - 1)
    return float(np.mean(np.minimum(dist[v, u], 20)))
best = (fit_cost(1, 0, 0), 1.0, 0, 0)
for step, ds in ((16, 0.02), (4, 0.005), (1, 0.002)):
    _, s0, x0, y0 = best
    for s in s0 + ds * np.arange(-3, 4):
        for tx in range(x0 - 4 * step, x0 + 4 * step + 1, step):
            for ty in range(y0 - 4 * step, y0 + 4 * step + 1, step):
                c = fit_cost(s, tx, ty)
                if c < best[0]: best = (c, float(s), tx, ty)
_, fs, ftx, fty = best

res = {'key': a.key, 'blockout': a.blockout,
       'edges': round(key_cover / max(self_cover, 1e-6), 3), 'edges_raw': round(key_cover, 3), 'edges_self': round(self_cover, 3),
       'edge_median_px': round(float(np.median(d)), 1),
       'led': None if key_led is None or not self_led else round(key_led / self_led, 3),
       'fit': {'shift_px': [ftx, fty], 'shift_pct': round(100 * max(abs(ftx), abs(fty)) / W, 2), 'scale': round(fs, 3)}}
res["pass"] = bool(res["edges"] >= 0.7 and (res["led"] is None or res["led"] >= 0.8))
print(json.dumps(res))
if a.json: json.dump(res, open(a.json, 'w'), indent=1)
if a.out:
    ov = key.copy()
    if (fs, ftx, fty) != (1.0, 0, 0):
        u = np.clip(((xs - W / 2) * fs + W / 2 + ftx).astype(int), 0, W - 1); v = np.clip(((ys - H / 2) * fs + H / 2 + fty).astype(int), 0, H - 1)
        ov[v, u] = (255, 0, 255)
    ov[outline] = (255, 255, 0)
    txt = f"edges {res['edges']:.2f}  LED {res['led']}  {'PASS' if res['pass'] else 'FAIL'}   best fit: shift {ftx},{fty} px, scale {fs:.3f}"
    for col, th in (((0, 0, 0), 5), ((255, 255, 255), 2)):
        cv2.putText(ov, txt, (20, 44), cv2.FONT_HERSHEY_SIMPLEX, 1.1, col, th, cv2.LINE_AA)
    cv2.imwrite(a.out, ov)
