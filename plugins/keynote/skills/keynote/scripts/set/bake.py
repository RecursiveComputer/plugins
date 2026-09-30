#!/usr/bin/env python3
"""Bake painted stations onto the blockout's exact geometry as one Gaussian splat (.ply).

  bake.py OUT.ply --station persp:BLOCKOUT_DIR:PLATE.png [--station pano:BLOCKOUT_DIR:PANO.png ...]
          [--skip-kinds 3] [--footprint 1.25] [--sky 600]

A station is one camera of the blockout (blockout.py output) and the painting made from it: `persp`
(a hero plate, sharp in its frustum) or `pano` (a 360 panorama, everything around). Every pixel
becomes a Gaussian at the blockout's exact depth, coloured by the painting. Stations are in
priority order: a pixel of a later station is dropped where an earlier perspective station
already sees that surface (so the sharp plate wins its frustum and the panorama fills the rest).
`--skip-kinds 3` leaves out the LED wall (render it as a real textured plane instead: always crisp).
Output: OUT-0.ply, OUT-1.ply, … (one per station; the browser renderer caps a mesh at ~2M splats),
three.js/Spark frame (x east, y up, z = -north), metres, standard 3DGS PLY.
"""
import argparse, json, os
os.environ.setdefault('OPENCV_IO_ENABLE_OPENEXR', '1')
import cv2
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('out'); ap.add_argument('--station', action='append', required=True)
ap.add_argument('--skip-kinds', default='', help='comma-separated object kinds to leave out (3 = led)')
ap.add_argument('--footprint', type=float, default=1.25); ap.add_argument('--sky', type=float, default=600.0)
ap.add_argument('--pano-width', type=int, default=2048)
a = ap.parse_args()
skip = {int(k) for k in a.skip_kinds.split(',') if k}


def exr(p):
    x = cv2.imread(p, cv2.IMREAD_UNCHANGED); return x[..., 0] if x.ndim == 3 else x


def frame(cam):
    at = np.array(cam['at'], np.float64); fwd = np.array(cam['look'], np.float64) - at; fwd /= np.linalg.norm(fwd)
    right = np.cross(fwd, [0, 0, 1.0]); right /= np.linalg.norm(right); up = np.cross(right, fwd)
    return at, fwd, right, up


def load(spec):
    kind, bdir, img = spec.split(':', 2)
    cam = json.load(open(os.path.join(bdir, 'camera.json')))
    at, fwd, right, up = frame(cam)
    if kind == 'pano':
        W = a.pano_width; H = W // 2
        dist = cv2.resize(exr(os.path.join(bdir, 'pano-dist.exr')), (W, H), interpolation=cv2.INTER_NEAREST)
        idx = cv2.resize(exr(os.path.join(bdir, 'pano-index.exr')), (W, H), interpolation=cv2.INTER_NEAREST)
        lon = ((np.arange(W) + 0.5) / W - 0.5) * 2 * np.pi; lat = (0.5 - (np.arange(H) + 0.5) / H) * np.pi
        LON, LAT = np.meshgrid(lon, lat)
        d = (np.cos(LAT) * np.cos(LON))[..., None] * fwd + (np.cos(LAT) * np.sin(LON))[..., None] * right + np.sin(LAT)[..., None] * up
        sky = ~np.isfinite(dist) | (dist > 1e6); r = np.where(sky, a.sky, dist)
        P = at + d * r[..., None]
        s = r * (2 * np.pi / W) * a.footprint
        # solid-angle sampling (equirect oversamples toward the poles), sky 3x sparser
        mask = np.zeros((H, W), bool); kx = np.zeros((H, W), np.float32)
        for y in range(H):
            k = int(min(W // 8, max(1, round(1 / max(np.cos(lat[y]), 1e-3))))); mask[y, ::k] = True; kx[y] = k
        sk = np.zeros((H, W), bool); sk[::3, ::3] = True
        mask &= ~sky | sk; kx = np.where(sky, kx * 3, kx); s = s * np.sqrt(kx)
    else:
        z = exr(os.path.join(bdir, 'persp-dist.exr')); H, W = z.shape
        idx = exr(os.path.join(bdir, 'persp-index.exr'))
        tx = np.tan(np.radians(cam['hfov_deg']) / 2); ty = tx * H / W
        xs = ((np.arange(W) + 0.5) / W * 2 - 1) * tx; ys = (1 - (np.arange(H) + 0.5) / H * 2) * ty
        X, Y = np.meshgrid(xs, ys)
        d = X[..., None] * right + Y[..., None] * up + fwd  # dot(d, fwd) == 1: z-depth scales it directly
        sky = ~np.isfinite(z) | (z > 1e6); zz = np.where(sky, a.sky, z)
        P = at + d * zz[..., None]
        s = zz * np.linalg.norm(d, axis=-1) * (2 * tx / W) * a.footprint
        mask = np.ones((H, W), bool)
    col = cv2.resize(cv2.imread(img), (W, H), interpolation=cv2.INTER_AREA if kind == 'pano' else cv2.INTER_CUBIC)[..., ::-1].astype(np.float32) / 255
    kinds = np.round(idx).astype(int)
    for k in skip: mask &= kinds != k
    st = dict(kind=kind, cam=cam, at=at, fwd=fwd, right=right, up=up, W=W, H=H, P=P, s=s, col=col, mask=mask, sky=sky)
    if kind == 'persp': st.update(z=np.where(sky, np.inf, z), tx=tx, ty=ty)
    return st


def covered(pts, st):
    """True where an earlier perspective station sees this point (same surface, in frame)."""
    v = pts - st['at']; zc = v @ st['fwd']
    with np.errstate(divide='ignore', invalid='ignore'):
        u = (v @ st['right']) / zc / st['tx']; w = (v @ st['up']) / zc / st['ty']
    inside = (zc > 0) & (np.abs(u) < 0.999) & (np.abs(w) < 0.999)
    px = np.clip(((u + 1) / 2 * st['W']).astype(int), 0, st['W'] - 1); py = np.clip(((1 - w) / 2 * st['H']).astype(int), 0, st['H'] - 1)
    zs = st['z'][py, px]
    return inside & (np.abs(zs - zc) < 0.02 * zc + 0.05)


stations = [load(s) for s in a.station]
allp, allc, alls = [], [], []
for i, st in enumerate(stations):
    pts = st['P'][st['mask']]; col = st['col'][st['mask']]; sc = st['s'][st['mask']]
    keep = np.isfinite(pts).all(1)
    for prev in stations[:i]:
        if prev['kind'] == 'persp': keep &= ~covered(pts, prev)
    allp.append(pts[keep]); allc.append(col[keep]); alls.append(sc[keep])
    print(f"station {i} {st['kind']}: {keep.sum()} splats")
def write_ply(path, pts, rgb, sc):
    xyz = np.stack([pts[:, 0], pts[:, 2], -pts[:, 1]], 1).astype(np.float32)
    dt = [(k, 'f4') for k in ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']]
    arr = np.zeros(len(xyz), dt)
    arr['x'], arr['y'], arr['z'] = xyz.T
    fdc = (rgb - 0.5) / 0.28209479177387814
    arr['f_dc_0'], arr['f_dc_1'], arr['f_dc_2'] = fdc.T
    arr['opacity'] = 6.0; ls = np.log(np.clip(sc, 1e-4, None))
    arr['scale_0'] = arr['scale_1'] = arr['scale_2'] = ls; arr['rot_0'] = 1.0
    with open(path, 'wb') as f:
        f.write(('ply\nformat binary_little_endian 1.0\nelement vertex %d\n' % len(arr) + ''.join('property float %s\n' % k for k, _ in dt) + 'end_header\n').encode())
        f.write(arr.tobytes())


# One PLY per station: the browser renderer packs a mesh into a GPU texture (~2M splats max), so
# stations stay separate meshes (render-splat.mjs takes a comma-separated list) and sets scale.
base = os.path.splitext(a.out)[0]
paths = []
for i, (p_, c_, s_) in enumerate(zip(allp, allc, alls)):
    path = f'{base}-{i}.ply'; write_ply(path, p_, c_, s_); paths.append(path)
    print(f'wrote {path}: {len(p_)} splats')
print(','.join(paths))
