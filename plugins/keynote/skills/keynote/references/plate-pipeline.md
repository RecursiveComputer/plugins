# Plate pipeline (the default for sets)

Every environment shot is an **approved still plate** plus code. Image generation makes the
photograph; the compositor (`scripts/comp/`) adds everything that must be exact or must move:
the camera, the wall's light and content, a breeze in the trees, stars, haze, grain. No video
model touches a frame, so nothing morphs, every frame is reproducible, and a shot costs
nothing to re-render. Video models (`fal-motion.py`) are the exception: only for a move a plate
can't fake, with an approved budget (runbook money rules).

Scratch: `~/.cache/keynote-sets/<set>/` (one folder per plate, shots in `shots/`, clips in `clips/`).

## 1. Plates

1. **One master frame first.** The hero, wall-on, at the film's time of day. Everything else is
   made from it, so it decides the look. Get it approved before generating anything else.
2. **Relight, don't regenerate.** To change time of day on an approved set, edit each existing
   plate ("keep the architecture, camera, framing and every object exactly; change only the light
   to …"). Edits keep the geometry; new generations drift.
3. **New angles from references.** Attach the master and the nearest existing angles (and the
   floor plan / clay view when the set has one) and describe the camera in metres. Batch them:

   ```sh
   S/plates/gen.sh JOBS.tsv SET_DIR        # name<TAB>ref1,ref2<TAB>prompt; 4+ run in parallel
   ```

   Keep one look sentence and paste it into every prompt.
4. **Wall-off twins.** For every plate that shows the wall and needs it to power on or off, edit
   the wall-on plate: "the same photograph; the only change: the wall is switched off … remove
   the light it casts". Then check registration:

   ```sh
   S/plates/align.py ON.png OFF.png         # must be ≤ 0.5 px; --fix OUT.png shifts it
   S/plates/wall-rect.py ON.png             # the face rect for the comp, in plate pixels
   ```

5. **Upscale.** Generators deliver ~1672×941; plates are pushed into up to ~1.35×.
   `S/plates/upscale-still.py IN.png OUT.png --model RealESRGAN_x2plus.pth --width 3840`
   (Real-ESRGAN x2 on the GPU, a little Lanczos mixed back so stone keeps its grain). Rects
   measured on the original scale by the same factor; measure on the upscaled plate instead.

## 2. Shots

A shot is JSON; paths are absolute or relative to the shot file.

```json
{
  "duration": 9, "fps": 30, "fadeIn": 0, "fadeOut": 0, "grain": 0.1, "vignette": 0.22,
  "plate": { "on": "hero.png", "off": "hero-off.png" },
  "camera": { "from": { "zoom": 1.06, "x": 0.5, "y": 0.5 }, "to": { "zoom": 1.0 }, "ease": "arrive", "duration": 3 },
  "wall": {
    "rect": { "x": 1650, "y": 540, "w": 1210, "h": 680 },
    "power": { "on": 1.4, "off": null, "ramp": 0.45 }, "minSpill": 0.35,
    "content": [ { "at": 0, "src": "card-name.png", "lum": 0.95 },
                 { "at": 4.6, "src": "ui/get-started.png", "bg": "#0c0c0e", "fit": 0.86, "lum": 0.22 } ],
    "reflection": null
  },
  "breeze": [ { "rect": { "x": 0, "y": 0, "w": 900, "h": 700 }, "amp": 1.4, "speed": 0.8, "anchor": "bottom" } ],
  "stars": { "horizon": 0.4 },
  "haze": { "y": 0.62, "h": 0.05, "alpha": 0.08, "speed": 5 },
  "lights": [ { "x": 400, "y": 700, "color": "#38bdf8", "at": 1.0, "scale": 1, "flatten": 0.35 } ]
}
```

- **Camera.** `ease: arrive` eases in fast and locks (every planned angle, the drone's landing);
  `linear` keeps a constant speed (drone shots you cut out of on motion); `in` accelerates
  (leaving). Zoom 1 = the plate covers the frame; the pan point is clamped so it always covers.
- **Drone without video.** Mode B from the runbook, built from plates: a funnel of 2–3 plates of
  decreasing distance (high aerial → approach → hero), each a `linear` push, cut on motion, the
  hero `arrive`-ing and locking. Out is the reverse with `in`. Reverse-scale pushes (zoom down
  from 1.3) read as a pull back.
- **Wall.** `power.on/off` cross the off and on plates with a reveal radiating from the wall's
  base; `lum` per card scales how much spill shows (a dark UI dims the courtyard). Content is
  multiplied onto the plate's own glowing face, so the bezel, glow and texture stay real.
- **Breeze.** Rects over canopies and grasses; small `amp` (1–2 plate px). Weighted to fade at
  the rect edges; `anchor: bottom` keeps trunks still.
- **Lights.** Practical lights on the ground (beacons): pool, core, optional `water` streak;
  each line travels `lineLead` seconds before the next light ignites.

## 3. Render and check

```sh
node S/comp/render.mjs shots/*.json --out clips/                  # ~real time on the GPU
node S/comp/render.mjs shots/hero.json --out stills/ --stills 0.5,2,6
python3 S/check-jitter.py clips/hero.mp4 3.2                       # locked after the settle
```

Clips go into the film as `clip` shots exactly like plate motion did: section titles over angles
(`labelSide: center`), the drone funnel as one `flight` clip, the wall shot `from` the hero's
landing. Review stills of every shot at its first frame, mid, and every wall beat before
rendering the film.
