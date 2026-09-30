#!/usr/bin/env python3
"""A painted 360 panorama + the blockout's exact distances → a 3D Gaussian splat (.ply).

  pano2splat.py BLOCKOUT_DIR PANO.png OUT.ply [--width 2048] [--sky 600] [--footprint 1.25]

BLOCKOUT_DIR is blockout.py's output for one camera (pano-dist.exr, camera.json). Every pixel
becomes one Gaussian at the blockout's distance along its ray, coloured from the painted
panorama: geometry comes from the layout (spatially exact), appearance from the generator.
Output frame is three.js/Spark (x east, y up, z = -north), metres, standard 3DGS PLY.
A single panorama only supports small moves (~1–3 m) before occluded areas show; add more
capture cameras for larger moves.
"""
import argparse, json, os
os.environ.setdefault('OPENCV_IO_ENABLE_OPENEXR', '1')
import cv2
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('blockout'); ap.add_argument('pano'); ap.add_argument('out')
ap.add_argument('--width', type=int, default=2048)
ap.add_argument('--sky', type=float, default=600.0, help='radius for sky pixels (metres)')
ap.add_argument('--footprint', type=float, default=1.25, help='splat size as a multiple of the pixel footprint')
a = ap.parse_args()

cam = json.load(open(os.path.join(a.blockout, 'camera.json')))
dist = cv2.imread(os.path.join(a.blockout, 'pano-dist.exr'), cv2.IMREAD_UNCHANGED)
dist = dist[..., 0] if dist.ndim == 3 else dist
W, H = a.width, a.width // 2
dist = cv2.resize(dist, (W, H), interpolation=cv2.INTER_NEAREST)
col = cv2.resize(cv2.imread(a.pano), (W, H), interpolation=cv2.INTER_AREA)[..., ::-1].astype(np.float32) / 255.0

# Camera frame exactly as blockout.py built it (Blender track: -Z forward, Y up).
at = np.array(cam['at'], np.float64); fwd = np.array(cam['look'], np.float64) - at; fwd /= np.linalg.norm(fwd)
right = np.cross(fwd, [0, 0, 1.0]); right /= np.linalg.norm(right); up = np.cross(right, fwd)
u = (np.arange(W) + 0.5) / W; v = (np.arange(H) + 0.5) / H
lon = (u - 0.5) * 2 * np.pi; lat = (0.5 - v) * np.pi
LON, LAT = np.meshgrid(lon, lat)
d = (np.cos(LAT) * np.cos(LON))[..., None] * fwd + (np.cos(LAT) * np.sin(LON))[..., None] * right + np.sin(LAT)[..., None] * up
sky = ~np.isfinite(dist) | (dist > 1e6)
r = np.where(sky, a.sky, dist)
P = at + d * r[..., None]
# Footprint: the pixel's angular size at its distance (latitude shrinks longitude spacing).
dth = 2 * np.pi / W
s = np.clip(r * dth * a.footprint, 1e-4, None)
# Sample by solid angle: equirectangular rows oversample toward the poles by 1/cos(lat), so a
# row keeps every k-th pixel (k ≈ 1/cos(lat)) with splats k times wider; sky is 3x sparser again.
# Uniform sampling doubles the count and crashes the browser renderer for no visible gain.
mask = np.zeros((H, W), bool)
kx = np.zeros((H, W), np.float32)
for y in range(H):
    k = int(min(W // 8, max(1, round(1 / max(np.cos(lat[y]), 1e-3)))))
    mask[y, ::k] = True; kx[y, :] = k
sky_keep = np.zeros((H, W), bool); sky_keep[::3, ::3] = True
mask &= ~sky | sky_keep
kx = np.where(sky, kx * 3, kx)
s = s * np.sqrt(kx)
pts = P[mask]; rgb = col[mask]; sc = s[mask]
keep = np.isfinite(pts).all(1)
pts, rgb, sc = pts[keep], rgb[keep], sc[keep]
# three.js frame: x east, y up, z = -north
xyz = np.stack([pts[:, 0], pts[:, 2], -pts[:, 1]], 1).astype(np.float32)
SH0 = 0.28209479177387814
fdc = ((rgb - 0.5) / SH0).astype(np.float32)
n = len(xyz)
dt = [('x', 'f4'), ('y', 'f4'), ('z', 'f4'), ('nx', 'f4'), ('ny', 'f4'), ('nz', 'f4'),
      ('f_dc_0', 'f4'), ('f_dc_1', 'f4'), ('f_dc_2', 'f4'), ('opacity', 'f4'),
      ('scale_0', 'f4'), ('scale_1', 'f4'), ('scale_2', 'f4'), ('rot_0', 'f4'), ('rot_1', 'f4'), ('rot_2', 'f4'), ('rot_3', 'f4')]
arr = np.zeros(n, dt)
arr['x'], arr['y'], arr['z'] = xyz[:, 0], xyz[:, 1], xyz[:, 2]
arr['f_dc_0'], arr['f_dc_1'], arr['f_dc_2'] = fdc[:, 0], fdc[:, 1], fdc[:, 2]
arr['opacity'] = 6.0
ls = np.log(sc).astype(np.float32)
arr['scale_0'] = arr['scale_1'] = arr['scale_2'] = ls
arr['rot_0'] = 1.0
with open(a.out, 'wb') as f:
    f.write(('ply\nformat binary_little_endian 1.0\nelement vertex %d\n' % n + ''.join('property float %s\n' % k for k, _ in dt) + 'end_header\n').encode())
    f.write(arr.tobytes())
cam_three = {'at': [cam['at'][0], cam['at'][2], -cam['at'][1]], 'look': [cam['look'][0], cam['look'][2], -cam['look'][1]], 'hfov_deg': cam['hfov_deg']}
json.dump(cam_three, open(os.path.splitext(a.out)[0] + '.camera.json', 'w'), indent=1)
led = None
print(f'wrote {a.out}: {n} splats; camera (three.js frame) {cam_three}')
