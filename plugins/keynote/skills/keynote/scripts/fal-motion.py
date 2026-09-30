#!/usr/bin/env python3
"""Generate subtle environmental motion for a set plate with Fal (MiniMax H3).

  fal-motion.py PLATE.png OUT.mp4 [--prompt "..."] [--duration 6] [--resolution 1080P]
                [--turbo] [--endpoint ...] [--no-end-frame] [--start-image A.png]
  fal-motion.py --text "..." OUT.mp4

Models (`--model`):
  h3        MiniMax H3 Max (`minimax/h3-max/...`): locked-off plate motion (leaves, light). Default.
            `--turbo` (`minimax/h3-max-turbo/...`) is for quick prompt tests only: never ship it.
  seedance  ByteDance Seedance 2.5 (`bytedance/seedance-2.5/us/image-to-video`): camera moves
            between two images (drone in/out). H3 invented trees and let buildings morph during
            a long move; Seedance keeps rigid geometry between the anchor frames.

The plate is the first frame (and, by default, also the last frame, which keeps the
shot anchored to the plate). The camera must stay locked: the keynote camera move is
added afterwards by live-plate.py, so the move follows the measured keynote ease.
Needs FAL_KEY (read from the environment or ~/.config/recursive-keynotes/fal.env).
"""
import argparse, base64, json, os, sys, time, urllib.request

LOCKED = ("Locked-off tripod shot; the camera does not move, pan, tilt or zoom at all. "
          "Only subtle natural motion: a gentle breeze moves the tree leaves and grasses a little, "
          "dappled shadows shift softly, light stays constant. No people, no animals, no new objects, "
          "no text. Photorealistic, identical framing to the first frame.")

ap = argparse.ArgumentParser()
ap.add_argument('plate', nargs='?'); ap.add_argument('out')
ap.add_argument('--text')
ap.add_argument('--prompt', default=LOCKED)
ap.add_argument('--duration', type=int, default=6)
ap.add_argument('--resolution', default='1080P')
ap.add_argument('--endpoint')
ap.add_argument('--no-end-frame', action='store_true')
ap.add_argument('--turbo', action='store_true', help='test-only: minimax/h3-max-turbo (never ship)')
ap.add_argument('--model', choices=['h3', 'seedance'], default='h3')
ap.add_argument('--resume', help='fetch a request submitted earlier (its id is in OUT.fal.json) instead of submitting')
ap.add_argument('--timeout', type=float, default=5400, help='seconds to wait for the queue (Seedance 1080p can take 30+ min)')
ap.add_argument('--seedance-res', default='480p', choices=['480p', '720p', '1080p'], help='Seedance resolution (1080p is $1.40/s: ~$14 per 10 s clip)')
ap.add_argument('--max-cost', type=float, default=1.0, help='refuse to submit when the estimated cost of this request exceeds this many USD')
ap.add_argument('--estimate', action='store_true', help='print the estimated cost and exit without submitting')
ap.add_argument('--start-image', help='first frame when it differs from the plate (a drone move from an aerial onto the plate)')
ap.add_argument('--end-only', action='store_true', help='the plate is the LAST frame only (e.g. a drone move that lands on the plate)')
a = ap.parse_args()

key = os.environ.get('FAL_KEY')
if not key:
    p = os.path.expanduser('~/.config/recursive-keynotes/fal.env')
    if os.path.exists(p):
        for line in open(p):
            if line.startswith('FAL_KEY='): key = line.split('=', 1)[1].strip()
if not key: sys.exit('FAL_KEY missing')


def call(url, body=None, tries=6):
    # Polls survive transient network errors (a long queue sees a few); submits are not retried.
    for k in range(tries if body is None else 1):
        req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                     headers={'Authorization': f'Key {key}', 'Content-Type': 'application/json'},
                                     method='POST' if body is not None else 'GET')
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read())
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if body is not None or k == tries - 1: raise
            print(f'  retry after network error: {e}', flush=True); time.sleep(10 * (k + 1))


if a.text:
    endpoint = a.endpoint or ('minimax/h3-max-turbo/text-to-video' if a.turbo else 'minimax/h3-max/text-to-video')
    body = {'prompt': a.text, 'duration': a.duration, 'resolution': a.resolution, 'aspect_ratio': '16:9'}
else:
    if a.model == 'seedance': endpoint = a.endpoint or 'bytedance/seedance-2.5/us/image-to-video'
    else: endpoint = a.endpoint or ('minimax/h3-max-turbo/image-to-video' if a.turbo else 'minimax/h3-max/image-to-video')
    def data_uri(p):
        return 'data:image/png;base64,' + base64.b64encode(open(p, 'rb').read()).decode()
    uri = data_uri(a.plate)
    if a.model == 'seedance':
        body = {'prompt': a.prompt, 'duration': str(a.duration), 'resolution': a.seedance_res, 'generate_audio': False}
    else:
        body = {'prompt': a.prompt, 'duration': a.duration, 'resolution': a.resolution, 'prompt_expansion_mode': 'disabled'}
    if a.start_image:
        # A move between two images: start frame given, the plate is where it lands.
        body['image_url'] = data_uri(a.start_image); body['end_image_url'] = uri
    elif a.end_only: body['end_image_url'] = uri
    else:
        body['image_url'] = uri
        if not a.no_end_frame: body['end_image_url'] = uri

# Cost guard. List prices per output second (fal.ai model pages, 2026-09-29; H3 prices double after
# the 2026-09-30 launch promo). A request above --max-cost (default $1) is refused: the person paying
# approves the estimate first, then passes --max-cost. Every submission is appended to the ledger.
PRICE_PER_S = {
    'minimax/h3-max-turbo': {'480P': 0.025, '768P': 0.04, '1080P': 0.08},
    'minimax/h3-max': {'480P': 0.05, '768P': 0.08, '1080P': 0.16},
    'bytedance/seedance-2.5': {'480p': 0.2646, '720p': 0.5676, '1080p': 1.396278},
}
app = '/'.join(endpoint.split('/')[:2])
res_key = a.seedance_res if a.model == 'seedance' else a.resolution
rate = PRICE_PER_S.get(app, {}).get(res_key)
est = rate * float(a.duration) if rate else None
if not a.resume:
    print(f'estimate: {endpoint} {res_key} {a.duration}s = ' + (f'${est:.2f}' if est is not None else 'unknown price'), flush=True)
    if a.estimate: sys.exit(0)
    if est is None or est > a.max_cost:
        sys.exit(f'refused: estimated {"$%.2f" % est if est is not None else "unknown cost"} exceeds --max-cost ${a.max_cost:.2f}. Get approval for the spend, then pass --max-cost.')

# The request id is written next to the output at once, so a long queue can be resumed.
base = '/'.join(endpoint.split('/')[:2])  # queue requests live under the app id (owner/app)
saved = json.load(open(a.out + '.fal.json')) if a.resume and os.path.exists(a.out + '.fal.json') else {}
if a.resume:
    rid = a.resume
    status_url = saved.get('status_url') or f'https://queue.fal.run/{base}/requests/{rid}/status'
    result_url = saved.get('response_url') or f'https://queue.fal.run/{base}/requests/{rid}'
else:
    sub = call(f'https://queue.fal.run/{endpoint}', body)
    rid = sub['request_id']
    status_url = sub.get('status_url') or f'https://queue.fal.run/{base}/requests/{rid}/status'
    result_url = sub.get('response_url') or f'https://queue.fal.run/{base}/requests/{rid}'
    json.dump({'endpoint': endpoint, 'request_id': rid, 'status_url': status_url, 'response_url': result_url, 'submitted': time.time()}, open(a.out + '.fal.json', 'w'))
    ledger = os.path.expanduser('~/.config/recursive-keynotes/fal-ledger.jsonl')
    os.makedirs(os.path.dirname(ledger), exist_ok=True)
    with open(ledger, 'a') as fh:
        fh.write(json.dumps({'t': time.strftime('%Y-%m-%dT%H:%M:%S'), 'endpoint': endpoint, 'res': res_key, 'seconds': a.duration, 'usd_est': est, 'request_id': rid, 'out': os.path.abspath(a.out)}) + '\n')
print('submitted' if not a.resume else 'resuming', endpoint, rid, flush=True)
t0 = time.time()
while True:
    st = call(status_url)
    if st.get('status') == 'COMPLETED': break
    if st.get('status') in ('FAILED', 'ERROR'): sys.exit(f'failed: {st}')
    if time.time() - t0 > a.timeout: sys.exit(f'timed out; resume with --resume {rid}')
    time.sleep(6)
res = call(result_url)
url = res['video']['url']
urllib.request.urlretrieve(url, a.out)
print('wrote', a.out, f'{time.time() - t0:.0f}s', flush=True)
