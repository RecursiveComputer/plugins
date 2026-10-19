// Render plate-comp shots (keynote kit): step comp.html per frame on the GPU, pipe to ffmpeg.
//   node render.mjs SHOT.json [SHOT2.json …] --out DIR           → DIR/<shot>.mp4
//   node render.mjs SHOT.json --out DIR --stills 0.5,3,6          → DIR/<shot>-<t>.jpg
// Asset paths in shot JSON are absolute (or relative to the shot file).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '../capture/record.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const shots = args.filter((a, i) => a.endsWith('.json') && !args[i - 1]?.startsWith('--'));
const out = path.resolve(opt('out') ?? '.');
fs.mkdirSync(out, { recursive: true });
const stills = opt('stills');

let current = null;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (url === '/shot.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(current)); }
  const file = url.startsWith('/fs/') ? url.slice(3) : path.join(here, url);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });

for (const s of shots) {
  const shotPath = path.resolve(s);
  const shot = JSON.parse(fs.readFileSync(shotPath, 'utf8'));
  const rel = (v) => (typeof v === 'string' && /\.(png|jpe?g|webp)$/i.test(v) ? `/fs${path.resolve(path.dirname(shotPath), v)}` : v);
  const walk = (o) => { for (const k in o) { if (o[k] && typeof o[k] === 'object') walk(o[k]); else o[k] = rel(o[k]); } };
  walk(shot);
  current = shot;
  const name = path.basename(shotPath, '.json');
  const W = shot.width ?? 1920, H = shot.height ?? 1080, fps = shot.fps ?? 30;
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log(`[${name}]`, e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/comp.html?shot=/shot.json`);
  await page.waitForFunction(() => window.compReady === true, null, { timeout: 60000, polling: 100 });
  const cdp = await page.context().newCDPSession(page);
  const grab = async () => Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 95 })).data, 'base64');
  if (stills) {
    for (const t of stills.split(',').map(Number)) {
      await page.evaluate((x) => window.renderAt(x), t);
      const f = path.join(out, `${name}-${t}.jpg`); fs.writeFileSync(f, await grab()); console.log(f);
    }
  } else {
    const file = path.join(out, `${name}.mp4`);
    const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(fps), '-i', '-',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file], { stdio: ['pipe', 'inherit', 'inherit'] });
    const t0 = Date.now();
    for (let n = 0; n < Math.round(shot.duration * fps); n++) {
      await page.evaluate((x) => window.renderAt(x), n / fps);
      const buf = await grab();
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    }
    ff.stdin.end(); await new Promise((r) => ff.on('close', r));
    console.log(`${file} ${shot.duration}s (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  await page.close();
}
await browser.close(); server.close();
