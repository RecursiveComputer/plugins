// Deterministic high-DPI recorder for product UI (keynote /keynote kit).
// Page time runs on Chrome virtual time: each output frame advances exactly 1/60 s,
// then a device-pixel screenshot is taken. Output: <name>.raw.mp4 (no cursor),
// <name>.positions.json / .timing.json (video pixels, release-recording format), stills.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { createRequire } from 'node:module';

// Playwright: the kit ships no node_modules. Resolve it from the project running the recorder,
// then from the keynote engine (KEYNOTE_ENGINE, or packages/demo-engine above this kit).
function loadPlaywright() {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const bases = [process.cwd()];
  if (process.env.KEYNOTE_ENGINE) bases.push(process.env.KEYNOTE_ENGINE);
  for (let d = here; d !== path.dirname(d); d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'packages/demo-engine/package.json'))) { bases.push(path.join(d, 'packages/demo-engine')); break; }
  }
  for (const b of bases) {
    try { return createRequire(path.join(b, 'package.json'))('playwright'); } catch {}
  }
  throw new Error(`playwright not found (looked from ${bases.join(', ')}); install it in the project or set KEYNOTE_ENGINE`);
}
export const { chromium } = loadPlaywright();

// Opens the product to record. Projects pass their own `open` (e.g. click into a seeded demo,
// sign in to a fixture account); the default loads KEYNOTE_URL. Never record live user data.
export async function openPage({ url = process.env.KEYNOTE_URL, width = 1440, height = 900, dpr = 2, theme = 'light', args = [] } = {}) {
  if (!url) throw new Error('openPage: set KEYNOTE_URL (a seeded/demo build of the product) or pass open() to record()');
  const browser = await chromium.launch({ channel: 'chromium', headless: true, args });
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, colorScheme: theme });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
  return { browser, page };
}

const FPS = 60;
const INTERACTIVE = 'button, a, input, textarea, select, [role="button"], [role="option"], [role="menuitem"], [role="tab"], [role="link"], [tabindex]:not([tabindex="-1"]), [onclick]';

// Nearest point to (x, y) with nothing interactive under it or within 12 px.
function safeSpot([x, y, sel, minR]) {
  const hot = (px, py) => {
    for (const [dx, dy] of [[0, 0], [12, 0], [-12, 0], [0, 12], [0, -12]]) {
      const e = document.elementFromPoint(px + dx, py + dy);
      if (!e || e.closest(sel)) return true;
    }
    return false;
  };
  for (let r = minR; r <= 320; r += 20) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2 + Math.PI / 4;
      const px = Math.round(x + r * Math.cos(a)), py = Math.round(y + r * Math.sin(a));
      if (px < 20 || py < 20 || px > innerWidth - 20 || py > innerHeight - 20) continue;
      if (!hot(px, py)) return [px, py];
    }
  }
  return null;
}
const smoother = (x) => x * x * x * (x * (x * 6 - 15) + 10);
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

// Finds the topmost visible element matching a spec (portals included; the
// marketing page underneath the full-bleed shell is excluded by hit-testing).
function finder(spec) {
  const scope = spec.within ? document.querySelector(spec.within) : document;
  let els = [...(scope || document).querySelectorAll(spec.css || 'button, a, [role=button], [role=option], [role=menuitem], [role=tab], li, div, span, p')];
  const text = (e) => (e.innerText || e.textContent || '').trim().replace(/\s+/g, ' ');
  if (spec.text) els = els.filter((e) => (spec.exact ? text(e) === spec.text : text(e).includes(spec.text)));
  if (spec.aria) els = els.filter((e) => (e.getAttribute('aria-label') || '').includes(spec.aria));
  // card: keep elements whose nearby (card-sized) ancestor mentions this text
  if (spec.card) els = els.filter((e) => {
    for (let a = e.parentElement, i = 0; a && i < 6; a = a.parentElement, i++) {
      const r = a.getBoundingClientRect();
      if (r.width * r.height > 520 * 420) return false;
      if (text(a).includes(spec.card)) return true;
    }
    return false;
  });
  const vis = els.filter((e) => {
    const r = e.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false;
    const cx = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2));
    const cy = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2));
    const hit = document.elementFromPoint(cx, cy);
    return !!hit && (e === hit || e.contains(hit) || hit.contains(e));
  });
  if (spec.text && !spec.css) vis.sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height);
  let e = vis[spec.nth || 0];
  if (!e) return null;
  for (let i = 0; i < (spec.up || 0) && e.parentElement; i++) e = e.parentElement; // container of the match
  const r = e.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height, cursor: getComputedStyle(e).cursor };
}

export class Director {
  constructor(page, cdp, enc, dpr, outDir, name) {
    Object.assign(this, { page, cdp, enc, dpr, outDir, name });
    this.n = 0;
    this.timings = [];
    this.positions = [];
    this.pointer = { x: 1400, y: 880 };
    this.down = false;
    // Per-frame pointer track (video px): the keynote engine draws the cursor from this,
    // so the drawn cursor is always exactly where hover and clicks happened.
    this.track = [];
    // Hover audit: hovered-element changes while the pointer is still.
    this.hover = { sig: null, history: [], changes: [], flips: [] };
    this.lastMoveN = -1;
  }
  /** Snap to whole device pixels so sub-pixel drift can't toggle hover at an edge. */
  snap(p) { const d = this.dpr; return { x: Math.round(p.x * d) / d, y: Math.round(p.y * d) / d }; }
  async auditHover() {
    const sig = await this.page.evaluate((sel) => {
      const deepest = [...document.querySelectorAll(':hover')].pop();
      // Hover styling lives on interactive elements; track the interactive target only.
      const h = deepest && deepest.closest(sel);
      if (!h) return '';
      // Identity only: an element sliding under the pointer (scroll) is the same hover.
      return `${h.tagName.toLowerCase()}.${String(h.className && h.className.baseVal !== undefined ? h.className.baseVal : h.className).split(' ').slice(0, 2).join('.')}|${(h.textContent || '').trim().slice(0, 24)}`;
    }, INTERACTIVE);
    const H = this.hover;
    if (sig === H.sig) return;
    // Still = no pointer motion for 0.1 s and not mid-click (press → release → step-aside).
    const still = this.n - this.lastMoveN > 6 && this.n - (this.lastReleaseN ?? -99) > 9;
    if (H.sig !== null && still) {
      const change = { t: +this.t.toFixed(3), from: H.sig, to: sig };
      H.changes.push(change);
      // Oscillation: back to a hover target we left < 0.5 s ago, pointer still = jitter.
      const back = H.history.find((h) => h.sig === sig && this.t - h.t < 0.5);
      if (back) H.flips.push(change);
    }
    H.history.push({ sig: H.sig, t: this.t });
    if (H.history.length > 8) H.history.shift();
    H.sig = sig;
  }
  get t() { return this.n / FPS; }
  async advance(ms) {
    // Watchdog: if the budget never reports expiry (renderer busy or stalled), note it and move on.
    await new Promise((res) => {
      const timer = setTimeout(() => { this.stalls = (this.stalls || 0) + 1; console.warn(`  ${this.name}: virtual time stalled at ${this.t.toFixed(2)}s (${this.step || ''})`); res(); }, 8000);
      this.cdp.once('Emulation.virtualTimeBudgetExpired', () => { clearTimeout(timer); res(); });
      this.cdp.send('Emulation.setVirtualTimePolicy', { policy: 'advance', budget: ms, maxVirtualTimeTaskStarvationCount: 5 }).catch((e) => { clearTimeout(timer); console.warn('  advance failed', e.message); res(); });
    });
  }
  async frame() {
    await this.advance(1000 / FPS);
    const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 95, optimizeForSpeed: true });
    if (!this.enc.stdin.write(Buffer.from(data, 'base64'))) await new Promise((r) => this.enc.stdin.once('drain', r));
    this.n++;
    const d = this.dpr;
    this.track.push({ t: +this.t.toFixed(4), x: Math.round(this.pointer.x * d), y: Math.round(this.pointer.y * d), ...(this.down ? { down: 1 } : {}) });
    await this.auditHover();
    if (this.n % 300 === 0) process.stdout.write(`  ${this.name} ${this.t.toFixed(1)}s\n`);
  }
  async frames(seconds) { for (let i = Math.round(seconds * FPS); i > 0; i--) await this.frame(); }
  async box(spec) {
    this.step = JSON.stringify(spec);
    if (process.env.TRACE) console.log(`  ${this.name} @${this.t.toFixed(2)} box ${this.step}`);
    const b = await this.page.evaluate(finder, spec);
    if (!b) throw new Error(`${this.name}: no visible element for ${JSON.stringify(spec)}`);
    return b;
  }
  push(actionType, startTime, extra = {}) {
    const actionIndex = this.timings.length;
    this.timings.push({ actionIndex, segmentIndex: 0, actionType, startTime: +startTime.toFixed(3), endTime: +this.t.toFixed(3), ...extra });
    return actionIndex;
  }
  async hold(seconds) { const s = this.t; await this.frames(seconds); this.push('wait', s); }
  async mouse(type, x, y, extra = {}) {
    ({ x, y } = this.snap({ x, y }));
    if (type === 'mouseMoved' || type === 'mouseWheel') this.lastMoveN = this.n;
    if (type === 'mousePressed') this.down = true;
    if (type === 'mouseReleased') { this.down = false; this.lastReleaseN = this.n; }
    // While virtual time is paused, Chrome acknowledges input only once time advances: a static
    // page (nothing else scheduled) would never ack. Don't block on the ack; the next advance
    // delivers the event, and CDP keeps messages in order.
    const sent = this.cdp.send('Input.dispatchMouseEvent', { type, x, y, button: extra.button ?? 'none', clickCount: extra.clickCount ?? 0, ...extra }).catch(() => {});
    await Promise.race([sent, new Promise((r) => setTimeout(r, 150))]);
  }
  async glide(to, dur) {
    const from = { ...this.pointer };
    const n = Math.max(1, Math.round(dur * FPS));
    for (let i = 1; i <= n; i++) {
      const p = smoother(i / n);
      const next = this.snap({ x: from.x + (to.x - from.x) * p, y: from.y + (to.y - from.y) * p });
      // Only real movement is dispatched: no redundant events at rest.
      if (next.x !== this.pointer.x || next.y !== this.pointer.y) {
        this.pointer = next;
        await this.mouse('mouseMoved', next.x, next.y);
      }
      await this.frame();
    }
  }
  /** Move to an element (spec) or point; optional click. Records telemetry in video pixels. */
  async moveTo(spec, { dur = 0.6, click = false, dwell = 0.12, after = 0.35, at = [0.5, 0.5], stay = false } = {}) {
    const b = spec.point ? { x: spec.point[0], y: spec.point[1], w: 1, h: 1, cursor: 'default' } : await this.box(spec);
    const target = { x: b.x + b.w * at[0], y: b.y + b.h * at[1] };
    const start = this.t;
    await this.glide(target, dur);
    const arrive = this.t;
    await this.frames(dwell);
    let trigger;
    if (click) {
      await this.mouse('mousePressed', target.x, target.y, { button: 'left', clickCount: 1 });
      await this.frames(0.07);
      trigger = this.t;
      await this.mouse('mouseReleased', target.x, target.y, { button: 'left', clickCount: 1 });
    }
    let rest = after;
    if (click && !stay) {
      // Presenters move the pointer out of the way after a click, so content that opens
      // under it never picks up a stray hover.
      const spot = await this.page.evaluate(safeSpot, [this.pointer.x, this.pointer.y, INTERACTIVE, 60]);
      if (spot) { await this.glide({ x: spot[0], y: spot[1] }, 0.3); rest -= 0.3; }
    }
    await this.frames(Math.max(0, rest));
    const d = this.dpr;
    const idx = this.push(click ? 'click' : 'moveTo', start, { pointerArriveTime: +arrive.toFixed(3), ...(click ? { triggerTime: +trigger.toFixed(3) } : {}) });
    this.positions.push({
      actionIndex: idx, x: Math.round(target.x * d), y: Math.round(target.y * d),
      cursorType: b.cursor === 'text' ? 'text' : 'pointer',
      targetX: Math.round(b.x * d), targetY: Math.round(b.y * d), targetW: Math.round(b.w * d), targetH: Math.round(b.h * d),
    });
    return idx;
  }
  click(spec, opts = {}) { return this.moveTo(spec, { ...opts, click: true }); }
  /**
   * The a-ha: the one visual that proves the flow's claim. Asserts it is visible,
   * moves the pointer off it, holds on it and records an `aha` timing entry
   * (the engine anchors narration and the cut to it). Every flow ends here.
   */
  async aha(spec, { hold = 2.2, label = 'aha', within = 3 } = {}) {
    // The proof may land a moment after the action (toasts, streamed results): wait for it.
    let b = null;
    for (let waited = 0; !b; waited += 1 / FPS) {
      b = await this.page.evaluate(finder, spec);
      if (b) break;
      if (waited > within) throw new Error(`${this.name}: a-ha never appeared within ${within}s: ${JSON.stringify(spec)}`);
      await this.frame();
    }
    const pad = 24;
    const inside = (p) => p.x > b.x - pad && p.x < b.x + b.w + pad && p.y > b.y - pad && p.y < b.y + b.h + pad;
    if (inside(this.pointer)) {
      let park = this.parkPoint;
      if (inside({ x: park[0], y: park[1] })) park = [Math.min(1420, b.x + b.w + 80), Math.min(880, b.y + b.h + 60)];
      await this.park(park);
    }
    const start = this.t;
    await this.frames(0.2);
    await this.still(label);
    await this.frames(Math.max(0, hold - 0.2));
    const d = this.dpr;
    const idx = this.push('aha', start);
    this.positions.push({ actionIndex: idx, x: Math.round((b.x + b.w / 2) * d), y: Math.round((b.y + b.h / 2) * d), cursorType: 'none',
      targetX: Math.round(b.x * d), targetY: Math.round(b.y * d), targetW: Math.round(b.w * d), targetH: Math.round(b.h * d) });
    this.ahaDone = true;
    return idx;
  }
  /** Move the pointer off interactive UI to a resting point (recorded like any move). */
  park(point = this.parkPoint, opts = {}) { return this.moveTo({ point }, { dur: 0.7, dwell: 0, after: 0.2, ...opts }); }
  /** Human typing cadence (deterministic jitter), one character per keystroke. */
  async type(text, { cps = 16 } = {}) {
    const start = this.t;
    let seed = 7;
    for (const ch of text) {
      await this.page.keyboard.type(ch);
      seed = (seed * 16807) % 2147483647;
      const jitter = 0.65 + (seed / 2147483647) * 0.7;
      await this.frames((1 / cps) * jitter * (ch === ' ' ? 1.3 : 1));
    }
    this.push('type', start);
  }
  async key(k, after = 0.3) { const s = this.t; await this.page.keyboard.press(k); await this.frames(after); this.push('key', s); }
  /** Wheel scroll at the pointer with an eased velocity profile. */
  async scroll(dy, dur = 1.2, after = 0.3) {
    const s = this.t;
    const n = Math.round(dur * FPS);
    let done = 0;
    for (let i = 1; i <= n; i++) {
      const want = Math.round(dy * easeInOut(i / n));
      if (want !== done) await this.mouse('mouseWheel', this.pointer.x, this.pointer.y, { deltaX: 0, deltaY: want - done });
      done = want;
      await this.frame();
    }
    await this.frames(after);
    this.push('scroll', s);
  }
  async still(label) {
    const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(this.outDir, 'stills', `${this.name}-${label}.png`), Buffer.from(data, 'base64'));
  }
}

export async function record(name, flowSpec, { outDir, width = 1440, height = 900, dpr = 2, open = openPage } = {}) {
  fs.mkdirSync(path.join(outDir, 'stills'), { recursive: true });
  const { browser, page } = await open({ width, height, dpr, theme: flowSpec.theme || 'light', args: ['--disable-smooth-scrolling'] });
  // `shell`: the app's root element when the flow names one (flowSpec.root), else the page body.
  const shell = page.locator(flowSpec.root || 'body');
  const { setup, flow } = flowSpec;
  if (setup) await setup({ page, shell });
  // Flow CSS (e.g. isolate one component on black) goes on after setup has found its elements.
  if (flowSpec.css) await page.addStyleTag({ content: flowSpec.css });
  // Keep the compositor producing frames: under paused virtual time a page with nothing
  // scheduled never acks input or screenshots (a busy app hides this; a static page stalls).
  await page.evaluate(() => {
    const k = document.createElement('div');
    k.setAttribute('aria-hidden', 'true');
    k.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1;animation:kn-keepalive 1s linear infinite';
    const st = document.createElement('style'); st.textContent = '@keyframes kn-keepalive { to { transform: translateX(1px); } }';
    document.head.appendChild(st); document.body.appendChild(k);
  });
  const start = flowSpec.start || [1400, 880];
  // Reset hover and focus from setup clicks through the same input channel the flow uses;
  // otherwise Chromium can keep a stale hover target that flickers on the first click.
  await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
  await page.mouse.move(start[0], start[1]);
  await page.waitForTimeout(1200);
  const cdp = await page.context().newCDPSession(page);
  // CDP sessions don't share Playwright's emulation: set device pixels explicitly or captures come back 1x.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false });
  await page.waitForTimeout(400);
  await cdp.send('Emulation.setVirtualTimePolicy', { policy: 'pause' });
  const file = path.join(outDir, `${name}.raw.mp4`);
  const enc = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(FPS), '-i', '-',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '12', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file], { stdio: ['pipe', 'inherit', 'inherit'] });
  const d = new Director(page, cdp, enc, dpr, outDir, name);
  d.pointer = d.snap({ x: start[0], y: start[1] });
  await d.mouse('mouseMoved', d.pointer.x + 1, d.pointer.y);
  await d.mouse('mouseMoved', d.pointer.x, d.pointer.y);
  d.parkPoint = flowSpec.park || start;
  const t0 = Date.now();
  try {
    await flow(d);
  } finally {
    enc.stdin.end();
    await new Promise((r) => enc.on('close', r));
    await browser.close();
  }
  if (!d.ahaDone && !flowSpec.broll) throw new Error(`${name}: flow never reached its a-ha (end with d.aha(spec), or mark the flow broll: true)`);
    fs.writeFileSync(path.join(outDir, `${name}.timing.json`), JSON.stringify(d.timings, null, 2));
  fs.writeFileSync(path.join(outDir, `${name}.positions.json`), JSON.stringify(d.positions, null, 2));
  fs.writeFileSync(path.join(outDir, `${name}.pointer.json`), JSON.stringify(d.track));
  fs.writeFileSync(path.join(outDir, `${name}.hover-audit.json`), JSON.stringify({ changes: d.hover.changes, flips: d.hover.flips }, null, 2));
  for (const c of d.hover.changes) console.warn(`  ${name}: hover changed under a still pointer at ${c.t}s: ${c.from || '(none)'} → ${c.to || '(none)'}`);
  // Something newly gaining hover under a still pointer is the visible artifact; losing hover is benign.
  const bad = d.hover.changes.filter((c) => c.to);
  if (bad.length && !flowSpec.allowStaticHover && !process.env.ALLOW_HOVER_FLIPS) {
    throw new Error(`${name}: interactive hover changed under a still pointer at ${bad.map((f) => f.t).join(', ')}s (see ${name}.hover-audit.json); park the pointer or move the step`);
  }
  console.log(`${name}: ${d.t.toFixed(2)}s (${d.n} frames) in ${((Date.now() - t0) / 1000).toFixed(0)}s → ${file}`);
  return d;
}
