#!/usr/bin/env python3
"""Bake painted stations onto the blockout's exact geometry as Gaussian splats (.ply).

  bake.py OUT.ply --station persp:BLOCKOUT_DIR:PLATE.png [--station pano:BLOCKOUT_DIR:PANO.png ...]
          [--skip-kinds 3] [--skip-dilate 3] [--no-sky] [--persp-width 1440] [--pano-width 2048]

A station is one camera of the blockout (blockout.py output) and the painting made from it: `persp`
(a plate, sharp in its frustum) or `pano` (a 360 panorama, everything around). Every pixel becomes
a Gaussian at the blockout's exact depth, coloured by the painting.

Fusion rule, in any order: for every surface point the station that sampled it finest wins.
A pixel's footprint is the true 3D spacing to its neighbouring pixels, so a surface seen at a
grazing angle counts as coarse. Other stations drop that point, so adding a station only ever
sharpens the set.

`--skip-kinds 3` leaves out the LED wall (render it as a real textured plane: always crisp), grown
by `--skip-dilate` px (a painting bleeds past the blockout edge; the screen's bezel covers the gap).
`--no-sky` leaves out sky pixels (render the sky as a dome: sky-env.py).

Output: OUT-0.ply, OUT-1.ply, … one per station (the browser renderer handles ~1.2–1.5M splats
per mesh; keep persp stations ≤ 1440 px wide). three.js/Spark frame (x east, y up, z = -north),
metres, standard 3DGS PLY. Prints the comma-separated list for render-splat.mjs.
"""
import argparse, json, os
os.environ.setdefault('OPENCV_IO_ENABLE_OPENEXR', '1')
import cv2
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('out'); ap.add_argument('--station', action='append', required=True)
ap.add_argument('--skip-kinds', default='', help='comma-separated object kinds to leave out (3 = led)')
ap.add_argument('--skip-dilate', type=int, default=3)
ap.add_argument('--no-sky', action='store_true')
ap.add_argument('--footprint', type=float, default=1.25, help='splat size as a multiple of the pixel footprint')
ap.add_argument('--sky', type=float, default=600.0, help='radius for sky pixels when kept (metres)')
ap.add_argument('--pano-width', type=int, default=2048)
ap.add_argument('--persp-width', type=int, default=1440)
ap.add_argument('--edge-feather', type=float, default=0.05, help='perspective plates fade out over this fraction of the frame at their edges (blends plate seams into the sky dome and other stations)')
ap.add_argument('--card-shadow', action='append', default=[], metavar='IMG:X:Y:HEIGHT:AZ:EL:OPACITY',
                help='bake the shadow of an element card (a tree) into the ground: IMG is the keyed RGBA card, X,Y its base (layout metres), '
                     'HEIGHT metres, AZ/EL the sun azimuth/elevation (deg), OPACITY 0-1. Baked, so walls occlude it correctly from every camera.')
a = ap.parse_args()
skip = {int(k) for k in a.skip_kinds.split(',') if k}


def exr(p):
    x = cv2.imread(p, cv2.IMREAD_UNCHANGED); return x[..., 0] if x.ndim == 3 else x


def resize_depth(z, W, H):
    """Depth at the new grid's pixel centres: linear on continuous surfaces (nearest shifts samples
    by up to half a source pixel: a 3% error on grazing ground), nearest across depth edges."""
    zf = np.where(np.isfinite(z) & (z < 1e6), z, 1e7).astype(np.float32)
    lin = cv2.resize(zf, (W, H), interpolation=cv2.INTER_LINEAR); near = cv2.resize(zf, (W, H), interpolation=cv2.INTER_NEAREST)
    return np.where(np.abs(lin - near) < 0.02 * near, lin, near)


def frame(cam):
    at = np.array(cam['at'], np.float64); fwd = np.array(cam['look'], np.float64) - at; fwd /= np.linalg.norm(fwd)
    right = np.cross(fwd, [0, 0, 1.0]); right /= np.linalg.norm(right); up = np.cross(right, fwd)
    return at, fwd, right, up


def tolerance(depth, sky):
    """Same-surface tolerance: 2% of depth + 5 cm + 3 pixels' worth of depth change (grazing)."""
    zg = np.where(sky, 0, depth).astype(np.float32)
    grad = np.hypot(cv2.Sobel(zg, cv2.CV_32F, 1, 0, ksize=3), cv2.Sobel(zg, cv2.CV_32F, 0, 1, ksize=3)) / 8
    return 0.02 * zg + 0.05 + 3 * np.minimum(grad, 1.0)


def load(spec):
    kind, bdir, img = spec.split(':', 2)
    cam = json.load(open(os.path.join(bdir, 'camera.json')))
    at, fwd, right, up = frame(cam)
    st = dict(kind=kind, at=at, fwd=fwd, right=right, up=up)
    if kind == 'pano':
        W = a.pano_width; H = W // 2
        depth = resize_depth(exr(os.path.join(bdir, 'pano-dist.exr')), W, H)
        idx = cv2.resize(exr(os.path.join(bdir, 'pano-index.exr')), (W, H), interpolation=cv2.INTER_NEAREST)
        lon = ((np.arange(W) + 0.5) / W - 0.5) * 2 * np.pi; lat = (0.5 - (np.arange(H) + 0.5) / H) * np.pi
        LON, LAT = np.meshgrid(lon, lat)
        d = (np.cos(LAT) * np.cos(LON))[..., None] * fwd + (np.cos(LAT) * np.sin(LON))[..., None] * right + np.sin(LAT)[..., None] * up
        sky = depth > 1e6; r = np.where(sky, a.sky, depth)
        P = at + d * r[..., None]
        ang = r * (2 * np.pi / W)
        # solid-angle sampling (equirect oversamples toward the poles), sky 3x sparser
        mask = np.zeros((H, W), bool); kx = np.ones((H, W), np.float32)
        for y in range(H):
            k = int(min(W // 8, max(1, round(1 / max(np.cos(lat[y]), 1e-3))))); mask[y, ::k] = True; kx[y] = k
        sk = np.zeros((H, W), bool); sk[::3, ::3] = True
        mask &= ~sky | sk; kx = np.where(sky, kx * 3, kx)
        st.update(W=W, H=H, depth=np.where(sky, np.inf, depth), tol=tolerance(depth, sky), alpha=np.ones((H, W), np.float32))
    else:
        z0 = exr(os.path.join(bdir, 'persp-dist.exr')); W = min(a.persp_width, z0.shape[1]); H = round(z0.shape[0] * W / z0.shape[1])
        depth = resize_depth(z0, W, H)
        idx = cv2.resize(exr(os.path.join(bdir, 'persp-index.exr')), (W, H), interpolation=cv2.INTER_NEAREST)
        tx = np.tan(np.radians(cam['hfov_deg']) / 2); ty = tx * H / W
        xs = ((np.arange(W) + 0.5) / W * 2 - 1) * tx; ys = (1 - (np.arange(H) + 0.5) / H * 2) * ty
        X, Y = np.meshgrid(xs, ys)
        d = X[..., None] * right + Y[..., None] * up + fwd  # dot(d, fwd) == 1: z-depth scales it directly
        sky = depth > 1e6; zz = np.where(sky, a.sky, depth)
        P = at + d * zz[..., None]
        ang = zz * np.linalg.norm(d, axis=-1) * (2 * tx / W)
        mask = np.ones((H, W), bool); kx = np.ones((H, W), np.float32)
        st.update(W=W, H=H, depth=np.where(sky, np.inf, depth), tol=tolerance(depth, sky), tx=tx, ty=ty)
        # Edge feather: opacity ramps up from the frame edge over `edge_feather` of the frame height.
        yy, xx = np.mgrid[0:H, 0:W]; edge = np.minimum.reduce([xx, W - 1 - xx, yy, H - 1 - yy]).astype(np.float32)
        st['alpha'] = np.clip(edge / max(1.0, a.edge_feather * H), 0.03, 1.0) if a.edge_feather > 0 else np.ones((H, W), np.float32)
    # True footprint: 3D spacing to the neighbouring pixels (the smaller side, so depth edges don't
    # count), at least the angular footprint and at most 4x it.
    dx = np.linalg.norm(np.diff(P, axis=1), axis=-1); dy = np.linalg.norm(np.diff(P, axis=0), axis=-1)
    fx = np.minimum(np.pad(dx, ((0, 0), (0, 1)), mode='edge'), np.pad(dx, ((0, 0), (1, 0)), mode='edge'))
    fy = np.minimum(np.pad(dy, ((0, 1), (0, 0)), mode='edge'), np.pad(dy, ((1, 0), (0, 0)), mode='edge'))
    fp = np.clip(np.maximum(fx, fy), ang, 4 * ang) * np.sqrt(kx)  # decides which station wins
    size = ang * np.sqrt(kx)  # splat size stays angular: large splats on grazing surfaces read as blobs
    col = cv2.resize(cv2.imread(img), (W, H), interpolation=cv2.INTER_AREA if kind == 'pano' else cv2.INTER_CUBIC)[..., ::-1].astype(np.float32) / 255
    kinds = np.round(idx).astype(int)
    # What this station can vouch for in fusion: every non-sky pixel it paints, including the
    # ones solid-angle thinning skipped (their neighbours' larger splats cover them).
    cov = ~sky
    # Foliage keying: the painting shows sky through the branches; on the blockout's canopy shell
    # those pixels would read as a glass ball from other angles. Drop sky-coloured foliage pixels.
    foliage = np.isin(kinds, [7, 8])
    b_, g_, r_ = col[..., 2], col[..., 1], col[..., 0]
    skyish = foliage & (b_ > r_ + 0.04) & (b_ > g_ - 0.02) & ((r_ + g_ + b_) / 3 > 0.45)
    mask &= ~skyish; cov &= ~skyish
    if a.no_sky: mask &= ~sky
    if skip:
        core = np.isin(kinds, list(skip)).astype(np.uint8)
        if a.skip_dilate > 0:
            # The painting bleeds the left-out object's colour a few pixels onto what lies behind
            # it (a white halo around the LED wall). Keep those surfaces, recoloured from their
            # surroundings (inpaint), so no other station has to fill a gap.
            ring = cv2.dilate(core, np.ones((2 * a.skip_dilate + 1,) * 2, np.uint8)) & (1 - core)
            c8 = (col * 255).astype(np.uint8)
            col = cv2.inpaint(c8, (ring | core).astype(np.uint8), 3 * a.skip_dilate, cv2.INPAINT_TELEA).astype(np.float32) / 255
        mask &= core == 0; cov &= core == 0
    st.update(P=P, fp=fp, size=size, col=col, mask=mask, cov=cov, kinds=kinds)
    return st


def sees(pts, st):
    """Flat pixel index where station `st` sees these points on the same surface, else -1."""
    v = pts - st['at']
    if st['kind'] == 'persp':
        zc = v @ st['fwd']
        with np.errstate(divide='ignore', invalid='ignore'):
            u = (v @ st['right']) / zc / st['tx']; w = (v @ st['up']) / zc / st['ty']
        inside = (zc > 0) & (np.abs(u) < 0.999) & (np.abs(w) < 0.999)
        px = np.clip(np.nan_to_num((u + 1) / 2 * st['W']).astype(int), 0, st['W'] - 1)
        py = np.clip(np.nan_to_num((1 - w) / 2 * st['H']).astype(int), 0, st['H'] - 1)
        ok = inside & (np.abs(st['depth'][py, px] - zc) < st['tol'][py, px])
    else:
        rr = np.linalg.norm(v, axis=1)
        lon = np.arctan2(v @ st['right'], v @ st['fwd']); lat = np.arcsin(np.clip((v @ st['up']) / np.maximum(rr, 1e-6), -1, 1))
        px = np.clip(((lon / (2 * np.pi) + 0.5) * st['W']).astype(int), 0, st['W'] - 1); py = np.clip(((0.5 - lat / np.pi) * st['H']).astype(int), 0, st['H'] - 1)
        ok = np.abs(st['depth'][py, px] - rr) < st['tol'][py, px]
    return np.where(ok, py * st['W'] + px, -1)


def write_ply(path, pts, rgb, sc, alpha=None):
    xyz = np.stack([pts[:, 0], pts[:, 2], -pts[:, 1]], 1).astype(np.float32)
    dt = [(k, 'f4') for k in ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']]
    arr = np.zeros(len(xyz), dt)
    arr['x'], arr['y'], arr['z'] = xyz.T
    fdc = (rgb - 0.5) / 0.28209479177387814
    arr['f_dc_0'], arr['f_dc_1'], arr['f_dc_2'] = fdc.T
    al = np.full(len(xyz), 0.9975) if alpha is None else np.clip(alpha, 0.03, 1.0) * 0.9975
    arr['opacity'] = np.log(al / (1 - al)); ls = np.log(np.clip(sc, 1e-4, None))
    arr['scale_0'] = arr['scale_1'] = arr['scale_2'] = ls; arr['rot_0'] = 1.0
    with open(path, 'wb') as f:
        f.write(('ply\nformat binary_little_endian 1.0\nelement vertex %d\n' % len(arr) + ''.join('property float %s\n' % k for k, _ in dt) + 'end_header\n').encode())
        f.write(arr.tobytes())


def card_shadow(pts, col, kinds_):
    """Darken ground points whose ray toward the sun passes through an element card's silhouette."""
    for spec in a.card_shadow:
        img, x, y, h, az, el, op = spec.split(':'); x, y, h, az, el, op = map(float, (x, y, h, az, el, op))
        card = cv2.imread(img, cv2.IMREAD_UNCHANGED); ch, cw = card.shape[:2]; w = h * cw / ch
        alpha = cv2.GaussianBlur(card[..., 3].astype(np.float32) / 255, (0, 0), 2.0)  # soft penumbra
        A, E = np.radians(az), np.radians(el)
        sun = np.array([np.sin(A) * np.cos(E), np.cos(A) * np.cos(E), np.sin(E)])  # toward the sun
        n = np.array([np.sin(A), np.cos(A), 0.0])  # the card faces the sun (vertical plane through the base)
        lat = np.array([np.cos(A), -np.sin(A), 0.0])
        g = kinds_ == 1
        if not g.any(): continue
        p = pts[g]; denom = sun @ n
        t = ((np.array([x, y, 0.0]) - p) @ n) / denom
        hitp = p + t[:, None] * sun
        u = (hitp - np.array([x, y, 0.0])) @ lat / w + 0.5; v = 1 - hitp[:, 2] / h
        ok = (t > 0) & (u >= 0) & (u < 1) & (v >= 0) & (v < 1)
        a_ = np.zeros(len(p)); a_[ok] = alpha[(v[ok] * ch).astype(int), (u[ok] * cw).astype(int)]
        col[g] = col[g] * (1 - op * a_)[:, None]
    return col


stations = [load(s) for s in a.station]
base = os.path.splitext(a.out)[0]
paths = []
for i, st in enumerate(stations):
    m = st['mask']
    pts = st['P'][m]; col = st['col'][m]; fp = st['fp'][m]; size = st['size'][m]
    if a.card_shadow: col = card_shadow(pts, col.copy(), st['kinds'][m])
    keep = np.isfinite(pts).all(1)
    for j, other in enumerate(stations):
        if j == i: continue
        k = sees(pts, other); hit = k >= 0
        kk = np.where(hit, k, 0)
        ofp = np.where(hit, other['fp'].reshape(-1)[kk], np.inf)
        oused = hit & other['cov'].reshape(-1)[kk]
        finer = ofp < fp * (1.0 if j < i else 0.8)  # ties go to the earlier station
        keep &= ~(oused & finer)
    path = f'{base}-{i}.ply'
    write_ply(path, pts[keep], col[keep], size[keep] * a.footprint, st['alpha'][m][keep]); paths.append(path)
    print(f"station {i} {st['kind']}: {keep.sum()} splats → {path}")
print(','.join(paths))
