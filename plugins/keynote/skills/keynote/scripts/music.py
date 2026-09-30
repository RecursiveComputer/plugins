#!/usr/bin/env python3
"""Generate a music cue with ElevenLabs Music (v2.5, instrumental) sized to a shot.

  music.py OUT.mp3 --seconds 10 --prompt "..."

Cues play only over the drone bookends (before the voice, and after it). Prompt from the
heuristic in references/research/session-breakdown-sept26-event.md: premium, minimal, a clean
resolved ending (no fade), no vocals, no trailer booms. Name what the picture does ("under a
slow aerial drone shot that glides down into a sunlit courtyard"). Check the loudness envelope
(`--envelope`) to see where the hit lands, and size the cue to the drone clip.
Needs ELEVENLABS_API_KEY with the music permission.
"""
import argparse, json, os, subprocess, sys, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument('out'); ap.add_argument('--seconds', type=float, required=True); ap.add_argument('--prompt', required=True)
ap.add_argument('--envelope', action='store_true', help='print the 0.25 s loudness envelope after generating')
a = ap.parse_args()
key = os.environ.get('ELEVENLABS_API_KEY') or sys.exit('ELEVENLABS_API_KEY missing')
body = {'model_id': 'music_v2_5', 'force_instrumental': True, 'music_length_ms': int(a.seconds * 1000), 'prompt': a.prompt}
req = urllib.request.Request('https://api.elevenlabs.io/v1/music?output_format=mp3_44100_192', data=json.dumps(body).encode(),
                             headers={'xi-api-key': key, 'Content-Type': 'application/json'}, method='POST')
with urllib.request.urlopen(req, timeout=300) as r:
    open(a.out, 'wb').write(r.read())
print('wrote', a.out)
if a.envelope:
    import numpy as np
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', a.out, '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], capture_output=True).stdout
    x = np.frombuffer(raw, np.int16).astype(float) / 32768; w = 2000
    print(' '.join(f'{20 * np.log10(np.sqrt(np.mean(x[i:i + w] ** 2)) + 1e-9):.0f}' for i in range(0, len(x) - w, w)))
