#!/usr/bin/env python3
"""Composite keynote content onto a PHYSICAL blank LED wall in a photographic plate.

The plate already contains a real-looking, blank white wall (lit, shadowed and
seated by the photograph or the image generator). We replace only its face with
our content, matching the plate's own measurements:

  * geometry   - the face quad is detected (bright, low-saturation, rectangular)
                 and content is warped into it with 2x supersampling;
  * white      - content white maps to the photographed wall white (per channel,
                 linear light), so the wall keeps the plate's colour cast;
  * shading    - a fraction of the face's photographed illumination is kept
                 (ambient light and shadow on an emissive panel);
  * lens       - content gets the plate's measured edge spread (10-90% rise);
  * grain      - content gets the plate's measured noise on the flat face;
  * bloom      - a faint halo from the brightest content, as a lens would.

usage: composite-plate.py plate.png frames_dir out_dir [--quad x1,y1,...,x4,y4] [--frames N] [--report]
"""
import argparse, json, os, sys
import cv2
import numpy as np

W, H = 1920, 1080


def srgb_to_lin(x):
    x = x.astype(np.float32) / 255.0
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055) * 255.0


def order_quad(pts):
    pts = np.array(pts, dtype=np.float32).reshape(4, 2)
    s = pts.sum(1); d = np.diff(pts, axis=1).ravel()
    return np.array([pts[np.argmin(s)], pts[np.argmin(d)], pts[np.argmax(s)], pts[np.argmax(d)]], dtype=np.float32)  # tl, tr, br, bl


def fit_quad(mask):
    """Four straight sides fitted to a region's boundary, for square-on or angled faces.

    Hull -> 4-point polygon, then each side is refit to the contour points nearest
    that segment (Huber line fit) and neighbouring sides are intersected.
    """
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    c = max(cnts, key=cv2.contourArea)
    hull = cv2.convexHull(c)
    peri = cv2.arcLength(hull, True)
    approx = None
    for eps in np.linspace(0.01, 0.08, 36):
        ap_ = cv2.approxPolyDP(hull, eps * peri, True)
        if len(ap_) == 4:
            approx = ap_
            break
    if approx is None:
        x, y, w, h = cv2.boundingRect(c)
        approx = np.array([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], np.float32)
    q0 = order_quad(approx)
    pts = c.reshape(-1, 2).astype(np.float32)
    lines = []
    for k in range(4):
        a, b = q0[k], q0[(k + 1) % 4]
        ab = b - a
        L = np.linalg.norm(ab)
        t = ((pts - a) @ ab) / (L * L)
        d = np.abs(np.cross(ab, pts - a)) / L
        sel = pts[(t > 0.1) & (t < 0.9) & (d < max(3.0, 0.02 * L))]
        if len(sel) < 10:
            lines.append((a, ab / L))
            continue
        vx, vy, px, py = cv2.fitLine(sel, cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
        lines.append((np.array([px, py]), np.array([vx, vy])))

    def cross(i, j):
        (p, r), (q, s2) = lines[i], lines[j]
        t = np.cross(q - p, s2) / np.cross(r, s2)
        return p + t * r
    # side k runs corner k -> k+1; corner k is the intersection of sides k-1 and k
    return np.array([cross(3, 0), cross(0, 1), cross(1, 2), cross(2, 3)], np.float32)


def detect_face(img):
    """The blank screen: the largest smooth, light, low-saturation, rectangular region.

    Region growing (flood fill on a lightly blurred image) follows the panel's
    gentle falloff; the rectangle/aspect/uniformity tests reject sky, walls and floor.
    """
    h, w = img.shape[:2]
    blur = cv2.GaussianBlur(img, (0, 0), 1.5)
    hsv = cv2.cvtColor(blur, cv2.COLOR_BGR2HSV)
    best = None
    # Fixed range (relative to the seed) first: bright faces sit well above the scene and
    # soft gradients cannot leak. Floating range is the fallback for faces with falloff.
    for mode, tol in ((cv2.FLOODFILL_FIXED_RANGE, 12), (0, 6)):
      for gy in np.linspace(0.2, 0.8, 7):
        for gx in np.linspace(0.15, 0.85, 9):
            seed = (int(gx * w), int(gy * h))
            if hsv[seed[1], seed[0], 1] > 45 or hsv[seed[1], seed[0], 2] < 120:
                continue
            mask = np.zeros((h + 2, w + 2), np.uint8)
            cv2.floodFill(blur.copy(), mask, seed, 0, (tol,) * 3, (tol,) * 3, 4 | mode | cv2.FLOODFILL_MASK_ONLY | (255 << 8))
            m = mask[1:-1, 1:-1]
            m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
            area = int((m > 0).sum())
            if area < 0.03 * w * h or area > 0.6 * w * h:
                continue
            cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            hull = cv2.convexHull(max(cs, key=cv2.contourArea))
            fill = area / max(1.0, cv2.contourArea(hull))
            x0, y0, bw, bh = cv2.boundingRect(hull)
            aspect = bw / float(bh)
            if fill < 0.93 or not 0.8 < aspect < 3.0:
                continue
            if best is None or area > best[0]:
                best = (area, m)
      if best is not None:
          break
    if best is None:
        raise SystemExit('no wall face found; pass --quad')
    q = fit_quad(best[1])
    return q


def inset(q, px):
    c = q.mean(0)
    return np.array([p + (c - p) / np.linalg.norm(c - p) * px for p in q], dtype=np.float32)


def grow(q, px):
    """Offset every side of a quad outward by px (corners move along both side normals)."""
    c = q.mean(0)
    out = []
    for i in range(4):
        p, a_, b_ = q[i], q[i - 1], q[(i + 1) % 4]
        acc = np.zeros(2, np.float32)
        for o in (a_, b_):
            d = (o - p) / np.linalg.norm(o - p)
            n = np.array([-d[1], d[0]], np.float32)
            if np.dot(n, p - c) < 0: n = -n
            acc += n
        out.append(p + acc * px)
    return np.array(out, np.float32)


def edge_rise(img_lin_y, q):
    """10-90% rise distance (px) across the face's top edge: the plate's lens + sensor softness."""
    rises = []
    p0, p1 = q[0], q[1]
    n = np.array([p1[1] - p0[1], -(p1[0] - p0[0])], dtype=np.float32); n /= np.linalg.norm(n)
    if n[1] > 0:
        n = -n  # point outward (up)
    for t in np.linspace(0.15, 0.85, 40):
        base = p0 + (p1 - p0) * t
        samples = [cv2.getRectSubPix(img_lin_y, (1, 1), tuple((base + n * d).tolist()))[0, 0] for d in np.arange(-8, 8.01, 0.25)]
        prof = np.array(samples)
        lo, hi = np.percentile(prof, 5), np.percentile(prof, 95)
        if hi - lo < 0.1:
            continue
        norm = (prof - lo) / (hi - lo)
        # inside (bright) is at negative d
        inside_first = norm[0] > norm[-1]
        if not inside_first:
            norm = norm[::-1]
        a = np.argmax(norm < 0.9); b = np.argmax(norm < 0.1)
        if b > a:
            rises.append((b - a) * 0.25)
    return float(np.median(rises)) if rises else 1.2


def face_stats(plate_lin, q):
    mask = np.zeros(plate_lin.shape[:2], np.uint8)
    cv2.fillConvexPoly(mask, inset(q, 6).astype(np.int32), 255)
    m = mask > 0
    white = np.array([np.median(plate_lin[..., c][m]) for c in range(3)], np.float32)
    y = plate_lin.mean(2)
    illum = cv2.GaussianBlur(y, (0, 0), 25)
    illum = illum / max(1e-6, np.median(illum[m]))
    hp = plate_lin - cv2.GaussianBlur(plate_lin, (0, 0), 1.5)
    noise = np.array([hp[..., c][m].std() for c in range(3)], np.float32)
    return white, illum, noise, mask


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('plate'); ap.add_argument('frames'); ap.add_argument('out')
    ap.add_argument('--quad'); ap.add_argument('--frames-count', type=int, default=0)
    ap.add_argument('--shade', type=float, default=0.35, help='share of photographed illumination kept on the emissive face')
    ap.add_argument('--bloom', type=float, default=0.035)
    ap.add_argument('--veil', type=float, default=0.03, help='ambient light reflected by the panel (lifts blacks, desaturates)')
    ap.add_argument('--content-zoom', type=float, default=1.0, help='crop content centre so full-screen layouts read at wall scale')
    ap.add_argument('--grain', type=float, default=0.85, help='per-frame grain over the whole frame, x measured plate noise (frozen grain reads as a still)')
    ap.add_argument('--wind', type=float, default=1.1, help='foliage sway amplitude in px (0 = off)')
    ap.add_argument('--reflect', type=float, default=0.45, help='strength of the content in a polished-floor reflection (0 = off)')
    ap.add_argument('--fps', type=float, default=30)
    ap.add_argument('--length', type=float, default=0, help='output seconds; the last content frame holds (grain and wind stay live)')
    ap.add_argument('--push', type=float, nargs=2, metavar=('START', 'DUR'), help='exit push into the wall (ease-in) starting at START seconds')
    ap.add_argument('--face-gain', type=float, default=1.0, help='wall brightness relative to the photographed blank face')
    ap.add_argument('--face-aspect', type=float, default=0.0, help='true face aspect (w/h); default measured from the quad (perspective-foreshortened faces need it)')
    ap.add_argument('--neutral', type=float, default=0.0, help='pull the wall white toward neutral (0..1); reference walls read neutral white')
    ap.add_argument('--only', type=int, nargs='*', help='frame indices to render (review stills)')
    ap.add_argument('--bleed', type=float, default=3.0, help='grow the detected face outward (px) so content covers the panel edge; a white rim shows otherwise')
    ap.add_argument('--bg-video', help='locked-off clip of this plate with natural motion (replaces the still behind the wall; foliage sway comes from the clip)')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    src = cv2.imread(a.plate, cv2.IMREAD_COLOR)
    plate = cv2.resize(src, (W, H), interpolation=cv2.INTER_LANCZOS4)
    q = order_quad([float(v) for v in a.quad.split(',')]) * np.array([W / src.shape[1], H / src.shape[0]], np.float32) if a.quad else detect_face(plate)
    if a.bleed:
        # Detection lands on the inside of the anti-aliased edge; push each side out.
        q = grow(q, a.bleed)
    plate_lin = srgb_to_lin(plate)
    white, illum, noise, face_mask = face_stats(plate_lin, q)
    if a.neutral > 0:
        white = white * (1 - a.neutral) + white.mean() * a.neutral
    rise = edge_rise(plate_lin.mean(2).astype(np.float32), q)
    sigma = max(0.35, rise / 2.563)
    report = {'quad': q.round(2).tolist(), 'white_lin': white.round(4).tolist(), 'noise_lin': noise.round(5).tolist(), 'edge_rise_px': round(rise, 3), 'content_sigma_px': round(sigma, 3)}

    # Foliage: saturated green/yellow-green, textured, away from the wall.
    hsv = cv2.cvtColor(plate, cv2.COLOR_BGR2HSV)
    green = ((hsv[..., 0] > 25) & (hsv[..., 0] < 95) & (hsv[..., 1] > 50)).astype(np.float32)
    tex = cv2.GaussianBlur(np.abs(cv2.Laplacian(cv2.cvtColor(plate, cv2.COLOR_BGR2GRAY).astype(np.float32), cv2.CV_32F)), (0, 0), 3)
    foliage = green * (tex > np.percentile(tex, 40))
    wall_block = np.zeros((H, W), np.uint8)
    cv2.fillConvexPoly(wall_block, inset(q, -25).astype(np.int32), 255)
    foliage[wall_block > 0] = 0
    foliage = cv2.GaussianBlur(foliage, (0, 0), 6)
    # sway grows with height (tree tops move most)
    foliage *= np.linspace(1.0, 0.35, H, dtype=np.float32)[:, None]
    gx, gy = np.meshgrid(np.arange(W, dtype=np.float32), np.arange(H, dtype=np.float32))

    # Reflection: mirror line = bottom of the dark base under the face.
    face_bottom = int(max(q[2][1], q[3][1]))
    xa, xb = int(q[3][0] + (q[2][0] - q[3][0]) * 0.2), int(q[3][0] + (q[2][0] - q[3][0]) * 0.8)
    rows = plate_lin[face_bottom + 3:min(H, face_bottom + 200), xa:xb].mean((1, 2))
    dark = int(np.argmax(rows < max(0.06, rows.min() * 1.8)))          # top of the dark base
    after = rows[dark:]
    lift = dark + int(np.argmax(after > max(0.12, rows.min() * 3.0)))    # floor below the base
    contact = face_bottom + 3 + lift
    report['reflection_contact_y'] = contact
    print('contact line', contact)

    frames = sorted(f for f in os.listdir(a.frames) if f.endswith(('.jpg', '.png')))
    print(json.dumps(report))
    json.dump(report, open(os.path.join(a.out, 'match.json'), 'w'), indent=1)
    if a.frames_count:
        frames = frames[:a.frames_count]
    total = int(round(a.length * a.fps)) if a.length else len(frames)
    idx = a.only if a.only else range(total)
    S = 2  # supersample the warp
    rng = np.random.default_rng(7)
    shade_map = (1 - a.shade) + a.shade * illum
    wall_c = q.mean(0)
    face_w = np.linalg.norm(q[1] - q[0]); face_h = np.linalg.norm(q[3] - q[0])
    z_end = min(W / face_w, H / face_h) * 1.04  # face just overfills the frame at the end of the push
    cache = {}
    # Face aspect (average of opposite sides): crop content to it instead of stretching.
    face_aspect = (np.linalg.norm(q[1] - q[0]) + np.linalg.norm(q[2] - q[3])) / (np.linalg.norm(q[3] - q[0]) + np.linalg.norm(q[2] - q[1]))
    if a.face_aspect:
        face_aspect = a.face_aspect
    report['face_aspect'] = round(float(face_aspect), 3)

    def load_content(i):
        k = min(i, len(frames) - 1)
        if k in cache:
            return cache[k]
        img = cv2.imread(os.path.join(a.frames, frames[k]), cv2.IMREAD_COLOR)
        if a.content_zoom > 1:
            fh, fw = img.shape[:2]
            cw0, ch0 = int(fw / a.content_zoom), int(fh / a.content_zoom)
            x0, y0 = (fw - cw0) // 2, (fh - ch0) // 2
            img = img[y0:y0 + ch0, x0:x0 + cw0]
        fh, fw = img.shape[:2]
        if fw / fh < face_aspect:      # face is wider: crop top/bottom
            nh = int(round(fw / face_aspect)); y0 = (fh - nh) // 2
            img = img[y0:y0 + nh]
        else:                           # face is taller: crop sides
            nw = int(round(fh * face_aspect)); x0 = (fw - nw) // 2
            img = img[:, x0:x0 + nw]
        cache.clear()
        cache[k] = srgb_to_lin(img)
        return cache[k]

    def content_layer(lin_src, quad, shade):
        """Content as an emissive panel inside `quad`: plate white, shading, veil, lens, bloom, grain."""
        ch, cw = lin_src.shape[:2]
        srcq = np.array([[0, 0], [cw, 0], [cw, ch], [0, ch]], np.float32)
        M = cv2.getPerspectiveTransform(srcq, quad * S)
        big = cv2.warpPerspective(lin_src, M, (W * S, H * S), flags=cv2.INTER_CUBIC)
        cover = cv2.warpPerspective(np.ones((ch, cw), np.float32), M, (W * S, H * S), flags=cv2.INTER_LINEAR)
        lin = cv2.resize(big, (W, H), interpolation=cv2.INTER_AREA)
        cov = cv2.resize(cover, (W, H), interpolation=cv2.INTER_AREA)[..., None]
        lit = lin * (white * a.face_gain)[None, None, :] * shade[..., None]
        if a.veil > 0:
            d = a.veil * 2
            grey = lit.mean(2, keepdims=True)
            lit = lit * (1 - d) + grey * d + white[None, None, :] * a.veil
        lit = cv2.GaussianBlur(lit, (0, 0), sigma)
        if a.bloom > 0:
            hot = np.clip(lit - white.mean() * 0.8, 0, None)
            lit = lit + cv2.GaussianBlur(hot, (0, 0), 14) * a.bloom * 10
        lit = lit + rng.normal(0, 1, lit.shape).astype(np.float32) * noise[None, None, :]
        return lit, cov

    bg = []
    if a.bg_video:
        cap = cv2.VideoCapture(a.bg_video); bg_fps = cap.get(cv2.CAP_PROP_FPS) or 24
        while True:
            ok, fr = cap.read()
            if not ok: break
            bg.append(fr)

    def scene(t, lit, cov):
        base = plate_lin
        if bg:
            fr = bg[min(len(bg) - 1, int(round(t * bg_fps)))]
            base = srgb_to_lin(cv2.resize(fr, (W, H), interpolation=cv2.INTER_LANCZOS4))
        elif a.wind > 0:
            # Low-frequency travelling sway: several incommensurate sines, so it never loops visibly.
            dx = (np.sin(gy * 0.021 + t * 1.3) * 0.6 + np.sin(gx * 0.013 + gy * 0.017 + t * 2.1) * 0.4 + np.sin(gx * 0.047 - t * 3.4) * 0.15) * a.wind * foliage
            dy = (np.cos(gx * 0.019 + t * 1.7) * 0.5 + np.sin(gx * 0.031 + t * 2.9) * 0.2) * a.wind * 0.5 * foliage
            base = cv2.remap(plate_lin, gx + dx, gy + dy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        out = base * (1 - cov) + lit * cov
        if a.reflect > 0:
            # The polished floor already reflects a bright blank panel; darken it where the content is dark.
            ratio = np.clip((lit.mean(2) / max(1e-6, white.mean())), 0, 1.2) * cov[..., 0] + (1 - cov[..., 0])
            span = contact - int(min(q[0][1], q[1][1]))
            refl = np.ones((H, W), np.float32)
            end = min(H, contact + span)
            refl[contact:end] = ratio[contact - span:contact][::-1][:end - contact]
            refl = cv2.GaussianBlur(refl, (0, 0), 7)
            fade = np.zeros((H, 1), np.float32)
            fade[contact:end, 0] = np.linspace(1, 0, end - contact) ** 1.6
            out = out * np.clip(1 - a.reflect * fade * (1 - refl), 0, 1)[..., None]
        return out

    def push_matrix(t):
        """Exit push (motion policy): accelerating ease-in toward the wall until its face fills the frame."""
        if not a.push:
            return None
        p = (t - a.push[0]) / a.push[1]
        if p <= 0:
            return None
        e = min(1.0, p) ** 3
        z = float(np.exp(np.log(z_end) * e))
        c = wall_c + (np.array([W / 2, H / 2], np.float32) - wall_c) * e
        return np.array([[z, 0, c[0] - z * wall_c[0]], [0, z, c[1] - z * wall_c[1]]], np.float32)

    def frame_at(i, t):
        src = load_content(i)
        lit, cov = content_layer(src, q, shade_map)
        out = scene(t, lit, cov)
        A = push_matrix(t)
        if A is not None:
            # Warp the plate; re-project the content at the new size so it stays sharp.
            out = cv2.warpAffine(out, A, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
            q2 = (np.hstack([q, np.ones((4, 1), np.float32)]) @ A.T).astype(np.float32)
            shade2 = cv2.warpAffine(shade_map, A, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
            lit2, cov2 = content_layer(src, q2, shade2)
            out = out * (1 - cov2) + lit2 * cov2
        return out

    for i in idx:
        t = i / a.fps
        moving = a.push and t >= a.push[0]
        if moving:
            # 180-degree shutter: 4 sub-frames averaged in linear light.
            acc = None
            for k in range(4):
                ts = t + ((k + 0.5) / 4 - 0.5) * (0.5 / a.fps)
                f = frame_at(i, ts)
                acc = f if acc is None else acc + f
            out = acc / 4
        else:
            out = frame_at(i, t)
        if a.grain > 0:
            out = out + rng.normal(0, 1, out.shape).astype(np.float32) * noise[None, None, :] * a.grain
        name = f'{i + 1:05d}.png' if a.only else f'{i + 1:05d}.jpg'
        params = [] if a.only else [cv2.IMWRITE_JPEG_QUALITY, 95]
        cv2.imwrite(os.path.join(a.out, name), lin_to_srgb(out).astype(np.uint8), params)

    if not a.only:
        print('frames', total)


if __name__ == '__main__':
    main()
