// Fly a camera path through a Gaussian splat (Spark), deterministically, to an MP4.
//   node render-splat.mjs SPLAT.ply[,MORE.ply…] PATH.json OUT.mp4 [--stills a,b,c]
// PATH.json: { "hfov_deg": 70, "fps": 30, "width": 1920, "height": 1080,
//              "keys": [{ "t": 0, "at": [x,y,z], "look": [x,y,z] }, …] }   (three.js frame, metres)
// Moves between keys on the keynote ease (fast attack, long settle), then lock.
// Optional "screens": [{ "center": [x,y,z], "width": w, "height": h, "yaw": 0, "image": "/abs/still.jpg" }] — real
// textured planes (the LED wall), always crisp; "image" may be a still for the whole shot.
// Needs three + @sparkjsdev/spark under $SPARK_ROOT/node_modules (default ~/.cache/keynote-sets/viewer).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from '../capture/record.mjs';

const [ply, pathFile, out] = process.argv.slice(2);
const stillsArg = process.argv.indexOf('--stills');
const stills = stillsArg > 0 ? process.argv[stillsArg + 1].split(',').map(Number) : null;
const P = JSON.parse(fs.readFileSync(pathFile, 'utf8'));
const W = P.width || 1920, H = P.height || 1080, FPS = P.fps || 30;
const ROOT = process.env.SPARK_ROOT || `${process.env.HOME}/.cache/keynote-sets/viewer`;
const HERE = path.dirname(new URL(import.meta.url).pathname);
const ORIGIN = 'https://splat.local';

const bez = (x1, y1, x2, y2, x) => { let lo = 0, hi = 1; for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; const bx = 3*(1-m)*(1-m)*m*x1 + 3*(1-m)*m*m*x2 + m*m*m; if (bx < x) lo = m; else hi = m; } const s = (lo + hi) / 2; return 3*(1-s)*(1-s)*s*y1 + 3*(1-s)*s*s*y2 + s*s*s; };
const kease = (x) => x <= 0 ? 0 : x >= 1 ? 1 : bez(0.4, 0.3, 0.4, 0.9, x);
const lerp = (a, b, u) => a.map((v, i) => v + (b[i] - v) * u);
// "sprites": [{ "base": [x,y,z], "height": m, "aspect": w/h, "image": "tree.png", "sway": 0.8,
//               "shadow": { "azimuthDeg": 247, "elevationDeg": 18 } }]   (sway: degrees of slow wind lean)
// "sky": an equirectangular sky dome (sky-env.py), "skyYawDeg" to align it. Keys may carry "hfov".
// "spline": true treats keys as control points of one Catmull-Rom move with a single ease
// ("ease": "inout" for flights that land; default keynote ease), instead of key-to-key moves.
const cr = (p0, p1, p2, p3, u) => p1.map((_, i) => 0.5 * ((2 * p1[i]) + (-p0[i] + p2[i]) * u + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * u * u + (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * u * u * u));
const inout = (x) => { const c = Math.max(0, Math.min(1, x)); return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2; };
function splinePose(t) {
  const k = P.keys, T = k[k.length - 1].t - k[0].t;
  const g = (P.ease === 'inout' ? inout : kease)((t - k[0].t) / T) * (k.length - 1);
  const i = Math.min(k.length - 2, Math.floor(g)), u = g - i;
  const K = (j) => k[Math.max(0, Math.min(k.length - 1, j))];
  const hf = (j) => K(j).hfov ?? P.hfov_deg;
  return { at: cr(K(i - 1).at, K(i).at, K(i + 1).at, K(i + 2).at, u), look: cr(K(i - 1).look, K(i).look, K(i + 1).look, K(i + 2).look, u), hfov: hf(i) + (hf(i + 1) - hf(i)) * u };
}
function pose(t) {
  if (P.spline) return splinePose(t);
  const k = P.keys; if (t <= k[0].t) return k[0];
  for (let i = 1; i < k.length; i++) if (t <= k[i].t) { const u = kease((t - k[i - 1].t) / (k[i].t - k[i - 1].t)); return { at: lerp(k[i - 1].at, k[i].at, u), look: lerp(k[i - 1].look, k[i].look, u) }; }
  return k[k.length - 1];
}

const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--js-flags=--max-old-space-size=12288'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 300)));
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) console.log('page', m.type(), m.text().slice(0, 300)); });
page.on('crash', () => console.log('page crashed'));
await page.route(`${ORIGIN}/**`, async (route) => {
  const url = new URL(route.request().url());
  const file = url.pathname === '/' ? `${HERE}/splat-viewer.html` : url.pathname.startsWith('/abs/') ? url.pathname.slice(4) : `${ROOT}${url.pathname}`;
  if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: 'nf' });
  const type = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.jpg': 'image/jpeg', '.png': 'image/png' }[path.extname(file)] || 'application/octet-stream';
  await route.fulfill({ body: fs.readFileSync(file), contentType: type });
});
await page.goto(`${ORIGIN}/`);
await page.waitForFunction(() => typeof window.__init === 'function', null, { timeout: 30000 });
const skyUrl = P.sky ? `${ORIGIN}/abs${path.resolve(P.sky)}` : null;
const sprites = (P.sprites || []).map((sp) => ({ ...sp, image: `${ORIGIN}/abs${path.resolve(sp.image)}` }));
const screens = (P.screens || []).map((sc) => ({ ...sc, image: sc.image ? `${ORIGIN}/abs${path.resolve(sc.image)}` : null }));
// Screen image sequences: { "sequence": { "dir": "frames/", "start": 10.35, "fps": 30 } } — frame k shows
// file k (sorted) from `start`; before it the first file, after the end the last (content powering on/off).
const seqs = (P.screens || []).map((sc) => sc.sequence ? { ...sc.sequence, files: fs.readdirSync(sc.sequence.dir).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort().map((f) => `${ORIGIN}/abs${path.resolve(sc.sequence.dir, f)}`) } : null);
const screenFrames = (t) => seqs.map((q) => q ? q.files[Math.max(0, Math.min(q.files.length - 1, Math.floor((t - q.start) * (q.fps || FPS))))] : null);
await page.evaluate((cfg) => window.__init(cfg), { width: W, height: H, hfov: P.hfov_deg || 60, plyUrls: ply.split(',').map((p) => `${ORIGIN}/abs${path.resolve(p)}`), screens, sprites, skyUrl, skyYawDeg: P.skyYawDeg || 0 });
const dur = P.keys[P.keys.length - 1].t + (P.hold || 0);
if (stills) {
  for (const t of stills) {
    await page.evaluate((f) => window.__frame(f), { ...pose(t), t, screens: screenFrames(t) });
    await page.screenshot({ path: out.replace(/\.mp4$/, '') + `-${t.toFixed(1)}.png` });
  }
} else {
  const ff = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  for (let n = 0; n < Math.round(dur * FPS); n++) {
    await page.evaluate((f) => window.__frame(f), { ...pose(n / FPS), t: n / FPS, screens: screenFrames(n / FPS) });
    const buf = await page.screenshot({ type: 'jpeg', quality: 92 });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
  }
  ff.stdin.end(); await new Promise((r) => ff.on('close', r));
}
await browser.close();
console.log('wrote', out, stills ? `stills at ${stills}` : `${dur}s`);
