#!/usr/bin/env python3
"""Generate a short shot from a start frame with a video model on OpenRouter (e.g. HeyGen Video 1).

  openrouter-video.py START.png OUT.mp4 --prompt "…" [--model heygen/heygen-video-1]
                      [--duration 6] [--resolution 480p] [--end END.png] [--seed N]
                      [--estimate] [--max-cost 1.0]

The same money rules as fal-motion.py: the price comes from OpenRouter's video model list and is
printed first; `--estimate` stops there; a request above `--max-cost` (default $1) is refused; every
submission is appended to ~/.config/recursive-keynotes/fal-ledger.jsonl; the clip is saved without
audio, and models that can skip their soundtrack are asked to (`--audio` keeps it; Veo prices it higher). `--end` adds a last frame for models that support one (the list's supported_frame_images;
HeyGen Video 1 takes a first frame only, so it suits multi-shot bookends, not the single shot).
Key: OPENROUTER_API_KEY, else Recursive's OpenRouter plugin key in the macOS keychain.
"""
import argparse, base64, json, os, subprocess, sys, time, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument('start'); ap.add_argument('out')
ap.add_argument('--prompt', required=True)
ap.add_argument('--model', default='heygen/heygen-video-1')
ap.add_argument('--duration', type=int, default=6)
ap.add_argument('--resolution', default='480p')
ap.add_argument('--aspect', default='16:9')
ap.add_argument('--end')
ap.add_argument('--seed', type=int)
ap.add_argument('--audio', action='store_true', help='keep the model soundtrack on (off by default: cheaper where the model prices it, and the film never uses it)')
ap.add_argument('--estimate', action='store_true')
ap.add_argument('--max-cost', type=float, default=1.0)
ap.add_argument('--timeout', type=float, default=1800)
a = ap.parse_args()

API = 'https://openrouter.ai/api/v1'
models = json.load(urllib.request.urlopen(f'{API}/videos/models', timeout=60))['data']
m = next((x for x in models if x['id'] == a.model), None)
if not m: sys.exit(f'{a.model} is not in OpenRouter\'s video model list')
for field, val in (('supported_durations', a.duration), ('supported_resolutions', a.resolution), ('supported_aspect_ratios', a.aspect)):
    if m.get(field) and val not in m[field]: sys.exit(f'{a.model}: {field} is {m[field]}, not {val}')
if a.end and 'last_frame' not in (m.get('supported_frame_images') or []):
    sys.exit(f'{a.model} takes {m.get("supported_frame_images")} only: no last frame')
skus = m.get('pricing_skus') or {}
aud = 'with_audio' if a.audio or not m.get('generate_audio') else 'without_audio'
res_key = a.resolution.lower()
rate = next((float(skus[k]) for k in (f'duration_seconds_{aud}_{res_key}', f'duration_seconds_{res_key}', f'duration_seconds_{aud}',
                                       'duration_seconds', 'per-video-second') if k in skus), None)
if rate is None and any(k.startswith('video_tokens') for k in skus):
    # Token-priced models (Seedance): ByteDance counts width x height x 24 fps / 1024 tokens per second.
    wh = {'480p': (854, 480), '720p': (1280, 720), '1080p': (1920, 1080), '4k': (3840, 2160)}[res_key]
    if a.aspect != '16:9': wh = (wh[1] * 16 // 9, wh[1])  # rough: same height
    per_tok = next(float(skus[k]) for k in (f'video_tokens_{res_key}_{aud}', f'video_tokens_{res_key}', f'video_tokens_{aud}', 'video_tokens') if k in skus)
    rate = wh[0] * wh[1] * 24 / 1024 * per_tok
est = rate * a.duration if rate else None
print(f'estimate: {a.model} {a.resolution} {a.duration}s ' + ('with audio' if aud == 'with_audio' else 'no audio') + ' = ' + (f'${est:.2f}' if est is not None else 'unknown price'), flush=True)
if a.estimate: sys.exit(0)
if est is None or est > a.max_cost:
    sys.exit(f'refused: estimated {"$%.2f" % est if est is not None else "unknown cost"} exceeds --max-cost ${a.max_cost:.2f}. Get approval for the spend, then pass --max-cost.')

key = os.environ.get('OPENROUTER_API_KEY')
if not key:
    r = subprocess.run(['security', 'find-generic-password', '-s', 'Recursive Plugin Settings', '-a', 'openrouter/apiKey', '-w'], capture_output=True, text=True)
    key = r.stdout.strip()
if not key: sys.exit('OPENROUTER_API_KEY missing (and no Recursive OpenRouter key in the keychain)')
H = {'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'}
try:  # refuse up front when the balance can't cover the clip (the submit would 402)
    cr = json.load(urllib.request.urlopen(urllib.request.Request(f'{API}/credits', headers=H), timeout=30)).get('data') or {}
    left = float(cr.get('total_credits', 0)) - float(cr.get('total_usage', 0))
    print(f'balance: ${left:.2f} left', flush=True)
    if left < est: sys.exit(f'refused: ${est:.2f} needed, ${left:.2f} left on OpenRouter; add credits at https://openrouter.ai/settings/credits')
    # The key can carry its own spending cap below the account balance (the submit would 403 "Key limit exceeded").
    kd = json.load(urllib.request.urlopen(urllib.request.Request(f'{API}/key', headers=H), timeout=30)).get('data') or {}
    if kd.get('limit') is not None and float(kd.get('limit_remaining') or 0) < est:
        sys.exit(f'refused: the OpenRouter key\'s own limit is ${float(kd["limit"]):.2f} with ${float(kd.get("limit_remaining") or 0):.2f} remaining '
                 f'(${est:.2f} needed); raise it at https://openrouter.ai/settings/keys')
except (urllib.error.URLError, ValueError, TypeError):
    pass


def call(url, body=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, headers=H, method='POST' if body is not None else 'GET')
    try:
        with urllib.request.urlopen(req, timeout=120) as r: return json.loads(r.read())
    except urllib.error.HTTPError as e:
        sys.exit(f'{e.code} from {url}: {e.read().decode()[:600]}')


def frame(p, kind):
    mime = 'image/jpeg' if p.lower().endswith(('.jpg', '.jpeg')) else 'image/png'
    return {'type': 'image_url', 'image_url': {'url': f'data:{mime};base64,' + base64.b64encode(open(p, 'rb').read()).decode()}, 'frame_type': kind}


body = {'model': a.model, 'prompt': a.prompt, 'duration': a.duration, 'resolution': a.resolution, 'aspect_ratio': a.aspect,
        'frame_images': [frame(a.start, 'first_frame')] + ([frame(a.end, 'last_frame')] if a.end else [])}
if a.seed is not None: body['seed'] = a.seed
if m.get('generate_audio'): body['generate_audio'] = bool(a.audio)  # the model lets us turn its soundtrack off
sub = call(f'{API}/videos', body)
jid = sub['id']
json.dump({'provider': 'openrouter', 'model': a.model, 'id': jid, 'polling_url': sub.get('polling_url'), 'submitted': time.time()}, open(a.out + '.or.json', 'w'))
ledger = os.path.expanduser('~/.config/recursive-keynotes/fal-ledger.jsonl')
os.makedirs(os.path.dirname(ledger), exist_ok=True)
with open(ledger, 'a') as fh:
    fh.write(json.dumps({'t': time.strftime('%Y-%m-%dT%H:%M:%S'), 'endpoint': f'openrouter:{a.model}', 'res': a.resolution, 'seconds': a.duration, 'usd_est': est, 'request_id': jid, 'out': os.path.abspath(a.out)}) + '\n')
print('submitted', a.model, jid, flush=True)
t0 = time.time()
while True:
    st = call(sub.get('polling_url') or f'{API}/videos/{jid}')
    if st.get('status') == 'completed': break
    if st.get('status') == 'failed': sys.exit(f'failed: {st.get("error")}')
    if time.time() - t0 > a.timeout: sys.exit(f'timed out; job {jid}')
    time.sleep(10)
raw = a.out + '.raw.mp4'
req = urllib.request.Request(st['unsigned_urls'][0], headers=H)
with urllib.request.urlopen(req, timeout=300) as r, open(raw, 'wb') as fh: fh.write(r.read())
subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', raw, '-map', '0:v', '-c', 'copy', a.out], check=True)
os.remove(raw)
cost = (st.get('usage') or {}).get('cost')
print('wrote', a.out, f'{time.time() - t0:.0f}s', f'(billed ${cost})' if cost is not None else '', flush=True)
