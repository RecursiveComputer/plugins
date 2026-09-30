#!/usr/bin/env python3
"""Automated gates from references/quality-rubric.md (the /keynote kit).

  validate-film.py FILM.json RENDER_DIR [--review review.json]

Writes RENDER_DIR/validation.json and prints a pass/fail table. `--review` merges scored
review items (R1–R10, 0–2 each) into the report and applies the scoring rule.
"""
import argparse, glob, json, os, re, subprocess, sys
import cv2
import numpy as np

ap = argparse.ArgumentParser(); ap.add_argument('film'); ap.add_argument('render'); ap.add_argument('--review')
a = ap.parse_args()
film = json.load(open(a.film))
plan = json.load(open(os.path.join(a.render, 'film.plan.json')))
mp4 = [p for p in glob.glob(os.path.join(a.render, '*.mp4')) if not p.endswith('.picture.mp4')][0]
res = {}


def gate(key, ok, detail):
    res[key] = {'pass': bool(ok), 'detail': detail}


# A1 legacy footage
srcs = []
def walk(o):
    if isinstance(o, dict):
        for k, v in o.items():
            if k == 'src' and isinstance(v, str): srcs.append(v)
            else: walk(v)
    elif isinstance(o, list):
        for v in o: walk(v)
walk(film)
legacy = [s for s in srcs if 'public/videos/demos' in s or re.search(r'release-\d', s) or '/recap/out/turns.desk' in s]
gate('A1 no legacy footage', not legacy, f'{len(srcs)} sources; legacy: {legacy[:3]}')

# A2 format
pr = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-of', 'json', mp4], capture_output=True, text=True).stdout)
v = next(s for s in pr['streams'] if s['codec_type'] == 'video'); au = [s for s in pr['streams'] if s['codec_type'] == 'audio']
fps = eval(v['r_frame_rate'])
gate('A2 format', v['width'] >= 1920 and v['height'] >= 1080 and abs(fps - 30) < 0.1 and v['codec_name'] == 'h264' and au and au[0]['codec_name'] == 'aac',
     f"{v['width']}x{v['height']} {fps:.2f}fps {v['codec_name']}/{au[0]['codec_name'] if au else '-'}")

# A3 loudness
out = subprocess.run(['ffmpeg', '-hide_banner', '-i', mp4, '-af', 'ebur128=peak=true', '-f', 'null', '-'], capture_output=True, text=True).stderr
I = float(re.findall(r'I:\s+(-?[\d.]+) LUFS', out)[-1]); TP = float(re.findall(r'Peak:\s+(-?[\d.]+) dBFS', out)[-1])
gate('A3 loudness', abs(I + 16) <= 1 and TP <= -0.9, f'I {I} LUFS, true peak {TP} dBTP')

# A4 music only at bookends
bed = os.path.join(a.render, 'music-cues.wav')
if os.path.exists(bed) and film.get('music', {}).get('cues'):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', bed, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], capture_output=True).stdout
    x = np.frombuffer(raw, np.int16).astype(np.float32) / 32768
    def dur(p): return float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p], capture_output=True, text=True).stdout)
    cues = film['music']['cues']
    open_end = dur(cues[0]['src']) + 0.5
    close_start = plan['duration'] - dur(cues[-1]['src']) - cues[-1].get('endPad', 0) - 0.5
    mid = x[int(open_end * 16000):int(close_start * 16000)]
    lvl = 20 * np.log10(np.sqrt(np.mean(mid ** 2)) + 1e-9) if len(mid) else -120
    gate('A4 music only at bookends', lvl < -60, f'middle {open_end:.1f}–{close_start:.1f}s at {lvl:.1f} dB')
else:
    gate('A4 music only at bookends', False, 'no bookend cues')

# A5/A6 plates steady and locked (environment clip shots; drone flights are exempt)
worst = []; flights = []
for s in plan['shots']:
    sh = s['shot']
    if sh['type'] != 'clip' or not re.search(r'/plates/(set|drone)-', sh['src']): continue
    if sh.get('flight'): flights.append(s['id']); continue
    frm = sh.get('from', 0) or 0
    # Set plates ease in and lock by 2.8 s; wall shots cut from a landed flight are locked from the cut.
    t0 = frm + (2.8 if '/plates/set-' in sh['src'] and frm == 0 else 0.2)
    t1 = frm + s['duration']
    cap = cv2.VideoCapture(sh['src']); vfps = cap.get(cv2.CAP_PROP_FPS) or 30; fr = []; k = 0
    while True:
        ok, f = cap.read()
        if not ok: break
        if t0 <= k / vfps <= t1: fr.append(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY).astype(np.float32))
        k += 1
    if len(fr) < 10: continue
    win = cv2.createHanningWindow(fr[0].shape[::-1], cv2.CV_32F)
    d = [cv2.phaseCorrelate(fr[i - 1], fr[i], win)[0] for i in range(1, len(fr))]
    rms = float(np.sqrt(np.mean([dx * dx + dy * dy for dx, dy in d])))
    worst.append((rms, s['id']))
worst.sort(reverse=True)
gate('A5/A6 plates steady + locked', all(r < 0.15 for r, _ in worst), ', '.join(f'{i} {r:.2f}px' for r, i in worst) + (f'; flights exempt: {flights}' if flights else ''))

# A11 no empty frames: a frame with (almost) nothing in it (flat black or one flat colour) for 0.5 s or more
raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', mp4, '-vf', 'fps=4,scale=192:108,format=gray', '-f', 'rawvideo', '-'], capture_output=True).stdout
g = np.frombuffer(raw, np.uint8).reshape(-1, 108, 192).astype(np.float32)
flat = [float(x.std()) < 4.0 for x in g]
runs = []; start = None
for i, f in enumerate(flat + [False]):
    if f and start is None: start = i
    if not f and start is not None:
        if (i - start) / 4 >= 0.5: runs.append((start / 4, i / 4))
        start = None
gate('A11 no empty frames', not runs, f'empty: {[(round(a, 2), round(b, 2)) for a, b in runs]}' if runs else f'{len(g)} samples, none empty')

# A7 overlays from frame one
late = [(s['id'], s['labelAt']) for s in plan['shots'] if s['shot'].get('labelSide') == 'center' and s.get('labelAt', 0) > 0.15]
gate('A7 overlays from frame one', not late, f'late: {late}' if late else 'all centre overlays at 0')

# A8 shot lengths
bad = [(s['id'], s['duration']) for s in plan['shots'] if s['duration'] < 1.0 or s['duration'] > 14]
gate('A8 shot lengths', not bad, f'{len(plan["shots"])} shots; out of range: {bad}')

# A9 text guard — enforced by the renderer (a render with clipped text fails)
gate('A9 text guard', True, 'renderer text guard passed (render completed)')

# A10 voice
gate('A10 voice', film.get('voice', {}).get('modelId') == 'eleven_v4' and all('script' in a_ for a_ in film['acts']), f"model {film.get('voice', {}).get('modelId')}; scripted acts {sum('script' in a_ for a_ in film['acts'])}/{len(film['acts'])}")

report = {'film': a.film, 'render': mp4, 'gates': res}
passed = all(g['pass'] for g in res.values())
if a.review:
    rv = json.load(open(a.review))
    pts = sum(x['score'] for x in rv.values()); mx = 2 * len(rv)
    star0 = [k for k, x in rv.items() if x.get('star') and x['score'] == 0]
    report['review'] = rv; report['review_score'] = f'{pts}/{mx}'
    passed = passed and pts >= 0.8 * mx and not star0
report['pass'] = passed
json.dump(report, open(os.path.join(a.render, 'validation.json'), 'w'), indent=1)
for k, g in res.items(): print(f"{'PASS' if g['pass'] else 'FAIL'}  {k:32s} {g['detail']}")
if a.review: print('review', report['review_score'])
print('OVERALL', 'PASS' if passed else 'FAIL')
sys.exit(0 if passed else 1)
