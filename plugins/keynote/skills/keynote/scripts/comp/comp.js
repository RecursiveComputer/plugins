// Plate compositor (keynote kit). An approved still plate is the photograph; everything that
// must be exact or must move is composited on top in code, as a pure function of shot time.
// No video model touches the frame, so nothing morphs and every frame is reproducible.
//
// Layers, bottom to top (all optional except the plate):
//   plate    the wall-off plate; the wall-on plate is revealed as the wall's light reaches out,
//            and how much of its spill shows follows what the wall displays (dark UI → less)
//   breeze   regions that sway gently (tree canopies, grasses): a smooth tile displacement
//   wall     the real content on the LED face, multiplied onto the plate's own glowing face
//   reflect  the content mirrored in a wet floor, blurred and rippling (wet ground only)
//   lights   small practical lights (beacons) with pools on the ground and streaks in water
//   stars    stars found in the plate twinkle in place
//   haze     a slow band drifting across the horizon
//   lens     the camera move (zoom + pan in plate space), vignette, grain, fades
//
// Shot JSON: see ../../references/plate-pipeline.md. Coordinates are plate pixels.
const params = new URLSearchParams(location.search);
const SHOT = await (await fetch(params.get('shot'))).json();
const W = SHOT.width ?? 1920, H = SHOT.height ?? 1080;
const canvas = document.getElementById('c');
canvas.width = W; canvas.height = H;
const ctx = canvas.getContext('2d');

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const settle = (lt, dur = 0.35) => { if (lt <= 0) return 0; const x = (lt / dur) * 6; return 1 - (1 + x) * Math.exp(-x); };
const EASE = {
  // eases in fast and locks (the keynote camera: critically damped)
  arrive: (s) => { const x = clamp01(s) * 7; return 1 - (1 + x) * Math.exp(-x); },
  linear: (s) => clamp01(s),
  // accelerating (leaving), and a symmetric ease for long drifts
  in: (s) => Math.pow(clamp01(s), 2.2),
  inout: (s) => { const t = clamp01(s); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; },
};
function mulberry32(seed) { return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const load = (src) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('load ' + src)); im.src = src; });
const mk = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });
const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${clamp01(a).toFixed(3)})`; };

const plateOn = await load(SHOT.plate.on);
const plateOff = SHOT.plate.off ? await load(SHOT.plate.off) : null;
const PW = plateOn.naturalWidth, PH = plateOn.naturalHeight;
const cover = Math.max(W / PW, H / PH);

const contentImages = {};
for (const c of SHOT.wall?.content ?? []) if (c.src && !contentImages[c.src]) contentImages[c.src] = await load(c.src);

// ── Stars: found in the plate's sky so they twinkle in place ────────────────
const stars = [];
if (SHOT.stars) {
  const s = mk(PW, PH); const sc = s.getContext('2d', { willReadFrequently: true });
  sc.drawImage(plateOn, 0, 0);
  const yMax = Math.round(SHOT.stars.horizon * PH);
  const d = sc.getImageData(0, 0, PW, yMax).data;
  const lum = (x, y) => { const k = (y * PW + x) * 4; return 0.3 * d[k] + 0.59 * d[k + 1] + 0.11 * d[k + 2]; };
  const rnd = mulberry32(5);
  for (let y = 3; y < yMax - 3; y++) for (let x = 3; x < PW - 3; x++) {
    const v = lum(x, y), ring = (lum(x - 3, y) + lum(x + 3, y) + lum(x, y - 3) + lum(x, y + 3)) / 4;
    if (v - ring > 38 && v >= lum(x - 1, y) && v >= lum(x + 1, y) && v >= lum(x, y - 1) && v >= lum(x, y + 1)) stars.push({ x, y, v: (v - ring) / 255, ph: rnd() * 6.283, sp: 1.5 + rnd() * 3 });
  }
}

// ── Haze texture: tileable horizontal fbm band ──────────────────────────────
let haze = null;
if (SHOT.haze) {
  haze = mk(1024, 128); const hc = haze.getContext('2d'); const img = hc.createImageData(1024, 128); const rnd = mulberry32(9);
  const grid = Array.from({ length: 33 * 5 }, () => rnd()); const val = (gx, gy) => grid[(gy % 5) * 33 + (gx % 32)];
  const s3 = (t) => t * t * (3 - 2 * t);
  const [hr, hg, hb] = SHOT.haze.color ?? [200, 214, 235];
  for (let y = 0; y < 128; y++) for (let x = 0; x < 1024; x++) {
    let v = 0, a = 0.5, f = 1;
    for (let o = 0; o < 4; o++) { const fx = (x / 1024) * 8 * f, fy = (y / 128) * f; const ix = Math.floor(fx), iy = Math.floor(fy); const tx = fx - ix, ty = fy - iy;
      v += a * lerp(lerp(val(ix, iy), val(ix + 1, iy), s3(tx)), lerp(val(ix, iy + 1), val(ix + 1, iy + 1), s3(tx)), s3(ty)); a *= 0.5; f *= 2; }
    const k = (y * 1024 + x) * 4; img.data[k] = hr; img.data[k + 1] = hg; img.data[k + 2] = hb; img.data[k + 3] = Math.max(0, v - 0.35) * 255 * Math.sin((y / 128) * Math.PI);
  }
  hc.putImageData(img, 0, 0);
}

// ── Wall content: a 16:9 card per beat, focus-settling on each change ───────
const contentCanvas = mk(1920, 1080); const cctx = contentCanvas.getContext('2d');
function drawContent(t) {
  let cur = null, prev = null;
  for (const c of SHOT.wall.content ?? []) if (t >= c.at) { prev = cur; cur = c; }
  cctx.fillStyle = '#ffffff'; cctx.fillRect(0, 0, 1920, 1080);
  if (!cur) return 1;
  const one = (c, alpha) => {
    cctx.save(); cctx.globalAlpha = alpha; cctx.fillStyle = c.bg ?? '#f3f3f1'; cctx.fillRect(0, 0, 1920, 1080);
    const im = contentImages[c.src];
    if (im) { const s = Math.min((1920 * (c.fit ?? 1)) / im.naturalWidth, (1080 * (c.fit ?? 1)) / im.naturalHeight); const w = im.naturalWidth * s, h = im.naturalHeight * s; cctx.drawImage(im, (1920 - w) / 2, (1080 - h) / 2, w, h); }
    cctx.restore();
  };
  // a card already on at the shot's start is simply there; later cards focus-settle in
  const k = cur.at > 0 || prev ? settle(t - cur.at, 0.35) : 1;
  if (prev && k < 1) one(prev, 1);
  if (k < 1) cctx.filter = `blur(${((1 - k) * 10).toFixed(1)}px)`;
  one(cur, prev ? k : 1);
  cctx.filter = 'none';
  return lerp(prev?.lum ?? 1, cur.lum ?? 1, k);
}

// ── Grain ───────────────────────────────────────────────────────────────────
const grain = mk(480, 270); const gctx = grain.getContext('2d'); const gimg = gctx.createImageData(480, 270);
function makeGrain(seed) { const rnd = mulberry32(seed); for (let i = 0; i < gimg.data.length; i += 4) { const v = 128 + (rnd() - 0.5) * 90; gimg.data[i] = gimg.data[i + 1] = gimg.data[i + 2] = v; gimg.data[i + 3] = 255; } gctx.putImageData(gimg, 0, 0); }

const work = mk(PW, PH); const wctx = work.getContext('2d');
window.shotDuration = SHOT.duration;

window.renderAt = async (t) => {
  // ── camera: zoom + pan in plate space, always covering the frame ──
  const cam = SHOT.camera ?? {};
  const from = cam.from ?? { zoom: 1, x: 0.5, y: 0.5 }, to = cam.to ?? from;
  const e = (EASE[cam.ease ?? 'arrive'])(((t - (cam.start ?? 0)) / (cam.duration ?? cam.settle ?? 2.4)));
  const zoom = lerp(from.zoom ?? 1, to.zoom ?? 1, e);
  const fx = lerp(from.x ?? 0.5, to.x ?? 0.5, e) * PW, fy = lerp(from.y ?? 0.5, to.y ?? 0.5, e) * PH;
  const sc = cover * zoom;
  const ox = Math.min(0, Math.max(W - PW * sc, W / 2 - fx * sc)), oy = Math.min(0, Math.max(H - PH * sc, H / 2 - fy * sc));

  // ── build the plate (in plate space) ──
  const wall = SHOT.wall;
  let power = 1, lum = 1;
  if (wall) {
    const p = wall.power ?? {};
    if (p.on != null) power = smooth(p.on, p.on + (p.ramp ?? 0.45), t);
    if (p.off != null) power = Math.min(power, 1 - smooth(p.off, p.off + (p.ramp ?? 0.45), t));
    if (!plateOff) power = 1;
    lum = drawContent(t);
  }
  wctx.globalAlpha = 1; wctx.globalCompositeOperation = 'source-over';
  wctx.drawImage(plateOff ?? plateOn, 0, 0);
  if (plateOff && power > 0) {
    // light reaches out from the wall's base: a radial reveal of the wall-on plate
    const cx = wall.rect.x + wall.rect.w / 2, cy = wall.rect.y + wall.rect.h;
    const lit = mk(PW, PH); const lc = lit.getContext('2d');
    lc.drawImage(plateOn, 0, 0);
    if (power < 0.999) {
      const r = Math.hypot(PW, PH) * power;
      lc.globalCompositeOperation = 'destination-in';
      const g = lc.createRadialGradient(cx, cy, r * 0.55, cx, cy, Math.max(1, r));
      g.addColorStop(0, '#000'); g.addColorStop(1, 'rgba(0,0,0,0)');
      lc.fillStyle = g; lc.fillRect(0, 0, PW, PH);
    }
    wctx.globalAlpha = power * lerp(wall.minSpill ?? 0.35, 1, lum);
    wctx.drawImage(lit, 0, 0);
    wctx.globalAlpha = 1;
  }

  // breeze: gentle sway of masked regions (canopies), drawn from the composed plate
  for (const b of SHOT.breeze ?? []) {
    const src = mk(b.rect.w, b.rect.h); src.getContext('2d').drawImage(work, b.rect.x, b.rect.y, b.rect.w, b.rect.h, 0, 0, b.rect.w, b.rect.h);
    const T = b.tile ?? 8, amp = b.amp ?? 1.5, sp = b.speed ?? 0.9;
    for (let ty = 0; ty < b.rect.h; ty += T) for (let tx = 0; tx < b.rect.w; tx += T) {
      const ex = Math.min(tx, b.rect.w - tx) / (b.rect.w * 0.18), ey = Math.min(ty, b.rect.h - ty) / (b.rect.h * 0.18);
      const wgt = clamp01(Math.min(ex, ey)) * (b.anchor === 'bottom' ? 1 - ty / b.rect.h : 1);
      const u = b.rect.x + tx, v = b.rect.y + ty;
      const dx = amp * wgt * (Math.sin(t * sp + u * 0.021 + v * 0.013) + 0.5 * Math.sin(t * sp * 1.9 + u * 0.047 - v * 0.031));
      const dy = amp * 0.35 * wgt * Math.sin(t * sp * 1.3 + u * 0.017 + v * 0.029);
      wctx.drawImage(src, tx, ty, T, T, b.rect.x + tx + dx, b.rect.y + ty + dy, T, T);
    }
  }

  // wall face: content multiplied onto the plate's own glowing face
  if (wall && power > 0) {
    const { x, y, w, h } = wall.rect;
    const sweep = clamp01(power * 1.6); // cabinets wake from the centre out
    wctx.save();
    wctx.beginPath(); const cw = w * sweep, ch = h * Math.min(1, sweep * 1.4); wctx.rect(x + (w - cw) / 2, y + (h - ch) / 2, cw, ch); wctx.clip();
    wctx.globalCompositeOperation = 'multiply';
    wctx.drawImage(contentCanvas, x, y, w, h);
    wctx.restore();
    if (wall.reflection) {
      const R = wall.reflection, rows = Math.round(R.h);
      const strip = mk(Math.round(w), rows); const sctx = strip.getContext('2d');
      sctx.save(); sctx.translate(0, rows); sctx.scale(1, -rows / h); sctx.filter = 'blur(2px)'; sctx.drawImage(contentCanvas, 0, 0, 1920, 1080, 0, 0, w, h); sctx.restore();
      wctx.save(); wctx.globalCompositeOperation = 'multiply';
      for (let i = 0; i < rows; i += 2) {
        const d = i / rows;
        const wob = Math.sin(i * 0.21 + t * 1.7) * (0.6 + 2.4 * d) + Math.sin(i * 0.053 - t * 0.9) * 1.2 * d;
        wctx.globalAlpha = power * lerp(R.near ?? 0.85, R.far ?? 0.2, d);
        wctx.drawImage(strip, 0, i, w, 2, x + wob, R.y + i, w, 2);
      }
      wctx.restore();
    }
  }

  // practical lights (beacons): line travels, then the light ignites with a pool on the ground
  const L = SHOT.lights ?? [];
  for (const [i, b] of L.entries()) {
    const next = L[i + 1];
    const lit = b.at == null ? 1 : smooth(b.at, b.at + 0.12, t);
    const flash = b.at != null && t > b.at ? 1 + 1.3 * Math.exp(-(t - b.at) * 3) : 1;
    const s = b.scale ?? 1;
    if (next && lit > 0 && SHOT.lightLines !== false) {
      const lead = SHOT.lineLead ?? 0.8;
      const g0 = next.at == null ? 1 : clamp01((t - (next.at - lead)) / lead);
      if (g0 > 0) {
        const ex = lerp(b.x, next.x, g0), ey = lerp(b.y, next.y, g0);
        wctx.save(); wctx.globalCompositeOperation = 'lighter'; wctx.lineCap = 'round';
        const grad = wctx.createLinearGradient(b.x, b.y, next.x, next.y); grad.addColorStop(0, b.color); grad.addColorStop(1, next.color);
        wctx.strokeStyle = grad; wctx.globalAlpha = 0.35; wctx.lineWidth = 5 * s; wctx.filter = 'blur(3px)';
        wctx.beginPath(); wctx.moveTo(b.x, b.y); wctx.lineTo(ex, ey); wctx.stroke();
        wctx.filter = 'none'; wctx.globalAlpha = 0.9; wctx.lineWidth = 1.2 * s; wctx.beginPath(); wctx.moveTo(b.x, b.y); wctx.lineTo(ex, ey); wctx.stroke();
        wctx.restore();
      }
    }
    if (lit <= 0) continue;
    wctx.save(); wctx.globalCompositeOperation = 'lighter';
    wctx.save(); wctx.translate(b.x, b.y); wctx.scale(1, b.flatten ?? 0.35);
    let g = wctx.createRadialGradient(0, 0, 0, 0, 0, 120 * s);
    g.addColorStop(0, hexA(b.color, 0.55 * lit * flash)); g.addColorStop(0.35, hexA(b.color, 0.16 * lit)); g.addColorStop(1, hexA(b.color, 0));
    wctx.fillStyle = g; wctx.beginPath(); wctx.arc(0, 0, 120 * s, 0, 6.283); wctx.fill(); wctx.restore();
    if (b.water) {
      wctx.save(); wctx.translate(b.x, b.y + 14 * s); wctx.scale(0.22, 1);
      g = wctx.createRadialGradient(0, 0, 0, 0, 0, 70 * s); g.addColorStop(0, hexA(b.color, 0.45 * lit)); g.addColorStop(1, hexA(b.color, 0));
      wctx.fillStyle = g; wctx.beginPath(); wctx.arc(0, 0, 70 * s, 0, 6.283); wctx.fill(); wctx.restore();
    }
    g = wctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, 15 * s);
    g.addColorStop(0, `rgba(255,255,255,${0.95 * lit})`); g.addColorStop(0.18, hexA(b.color, 0.75 * lit * flash)); g.addColorStop(0.5, hexA(b.color, 0.12 * lit * flash)); g.addColorStop(1, hexA(b.color, 0));
    wctx.fillStyle = g; wctx.beginPath(); wctx.arc(b.x, b.y, 15 * s, 0, 6.283); wctx.fill();
    wctx.restore();
  }

  if (stars.length) {
    wctx.save(); wctx.globalCompositeOperation = 'lighter';
    for (const st of stars) { const a = st.v * 0.55 * (Math.sin(t * st.sp + st.ph) * 0.5 + 0.5); if (a < 0.01) continue; wctx.fillStyle = `rgba(220,230,255,${a.toFixed(3)})`; wctx.fillRect(st.x - 0.7, st.y - 0.7, 1.4, 1.4); }
    wctx.restore();
  }
  if (haze) {
    const hz = SHOT.haze; wctx.save(); wctx.globalAlpha = hz.alpha ?? 0.1; wctx.globalCompositeOperation = 'screen';
    const o = ((t * (hz.speed ?? 6)) % PW + PW) % PW, y = hz.y * PH, h = (hz.h ?? 0.08) * PH;
    wctx.drawImage(haze, -o, y - h / 2, PW, h); wctx.drawImage(haze, PW - o, y - h / 2, PW, h);
    wctx.restore();
  }

  // ── frame: camera, vignette, grain, fades ──
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(sc, 0, 0, sc, ox, oy);
  ctx.drawImage(work, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 1.05);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, `rgba(0,0,0,${SHOT.vignette ?? 0.22})`);
  ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
  makeGrain(Math.floor(t * 30) + 1);
  ctx.save(); ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = SHOT.grain ?? 0.1; ctx.drawImage(grain, 0, 0, W, H); ctx.restore();
  const fi = SHOT.fadeIn ?? 0, fo = SHOT.fadeOut ?? 0;
  const f = Math.max(fi ? 1 - smooth(0, fi, t) : 0, fo ? smooth(SHOT.duration - fo, SHOT.duration, t) : 0);
  if (f > 0) { ctx.fillStyle = `rgba(0,0,0,${f})`; ctx.fillRect(0, 0, W, H); }
  return true;
};
window.compReady = true;
