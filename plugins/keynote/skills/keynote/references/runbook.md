# Keynote runbook

The end-to-end flow for an announcement film, written so a fresh session can run it from
nothing and land the same quality every time. Each step names its tool, its output, and the
check that passes before moving on. `S` = this skill's `scripts/`. Rules: `quality-rubric.md`
(gates A1–A11, review R1–R12), `craft.md`, `film-format.md`. Project specifics (brand, voice,
capture, set): the project's `KEYNOTE.md` (`project-profile.md`).

Scratch: `~/.cache/keynote-sets/<project>/<version>/` (W below). Keys: `FAL_KEY` from the
environment or `~/.config/recursive-keynotes/fal.env`; `ELEVENLABS_API_KEY` from the
environment (e.g. `set -a && . ./.env; set +a`). Neither is ever written into a repository.

## Money: generated video is the expensive part

Fal bills per output second, and one careless run costs more than the whole rest of the film.
List prices (fal.ai, 2026-09-30; turbo shown at its post-promo rate; H3 bills at least 5 s):

| Model | 480p | 720p/768p | 1080p | A 10 s clip at 1080p |
| --- | --- | --- | --- | --- |
| H3 Max Turbo | $0.025/s | $0.04/s | $0.08/s | $0.80 |
| H3 Max | $0.05/s | $0.08/s | $0.16/s | $1.60 |
| Seedance 2.5 | $0.26/s | $0.57/s | $1.40/s | $13.96 |
| Seedance 2.5 (OpenRouter, per token) | ~$0.10/s | ~$0.23/s (720p max) | none | n/a |
| Veo 3.1 Lite (OpenRouter, no audio) | n/a | $0.03/s (720p) | $0.05/s | rejected: looks bad |
| Wan 3.0 (OpenRouter, first frame only) | $0.05/s | $0.10/s | $0.20/s | n/a |
| HeyGen Video 1 (OpenRouter) | $0.02/s list (billed $0.01/s at launch) | $0.03/s at 768p | none | n/a (768p max) |

Rules:
1. **No generation without an approved budget.** Before any Fal call, show the person paying the
   list of clips with `fal-motion.py … --estimate` totals and get a yes. `fal-motion.py` refuses
   any request estimated over `--max-cost` (default $1) and logs every submission to
   `~/.config/recursive-keynotes/fal-ledger.jsonl`.
2. **Reuse before generating.** The set, plate motion and drone moves carry across films: check
   the project's set folder first. A drone-out played in reverse is a drone-in on the same path.
3. **Test cheap, once.** Prove a prompt with ONE clip at 480p (H3 Max Turbo, the default; `--seedance-res 480p`
   for Seedance), 4–5 s. Only the approved final goes to 1080p, and never two at once.
4. **Don't regenerate to fix what editing can fix** (masking, pinning, trimming, reversing).
5. When the account locks (`User is locked`), stop: a finished request's result cannot be fetched
   until the balance is topped up; `--resume <id>` fetches it afterwards.
5b. **Cheapest test path:** `S/openrouter-video.py START.png OUT.mp4 --prompt "…"` (HeyGen Video 1 on
   OpenRouter, 480p, first frame only, ~14 s turnaround; key from Recursive's OpenRouter plugin). It is for
   multi-shot tests only: no end frame (no single shot) and 768p at most (no finals; `S/upscale.py`
   takes a clip to 1080p locally with Real-ESRGAN). Don't use Veo 3.1 Lite: the person approving the film judged its
   output ugly (over-sharpened, wormy texture; a doubled tree). **Seedance 2.5 on OpenRouter**
   (`--model bytedance/seedance-2.5`, first + last frame, 4-30 s) is the quality pick, at about 2.5x
   less than Fal per second but 720p at most there (Fal has 1080p). **Wan 3.0 on OpenRouter**
   (`--model alibaba/wan-3.0`) goes to 1080p ($0.05/s 480p, $0.10/s 720p, $0.20/s 1080p; 2-30 s)
   but takes a first frame only, so a single shot must describe its landing in the prompt and be
   joined to the plate; Wan 2.7 takes first + last frame at 720p/1080p for $0.10/s. The script checks
   the OpenRouter balance and the key's own spending limit before submitting (a key capped below
   the balance 403s "Key limit exceeded").
6. **Pipeline tests run on Turbo at 480P** (`fal-motion.py`'s defaults, $0.025/s). Add `--max
   --resolution 1080P` only for the approved final shots, after the cut works end to end.
7. **No soundtrack.** H3 always generates audio (no switch, no discount); Seedance's is turned off in
   the request. `fal-motion.py` saves every clip without audio: the film's sound is the voice and the
   music cues only.

## 0. Script

1. From the update's notes, pick the three questions a user would ask ("what does it know,
   what did it change, what is it allowed to do"). One chapter answers each; then reach (breadth),
   "so much more" (bento), recap, close.
2. Write each act as one continuous take (`script` with `{cues}`, `film-format.md`). Plain,
   first person plural, present tense; phrases short; on-screen lines reinforce with different
   words. Numbers only from the notes.
3. Plan one shot per beat and give each a purpose (R11): a section title over an angle, the
   wall, a drone move, a real UI beat, or a motion graphic that ends on real UI.

## 1. The set (once per project; reuse across films)

**Default: the plate pipeline** (`references/plate-pipeline.md`): approved stills + the compositor
(`S/comp/`), no video model in the frame. Relight an approved set by editing its plates; build drone
moves as a funnel of plates cut on motion. The steps below make the set and its plates; skip step 5
(plate motion) unless a move truly needs a video model and the budget is approved.

Keep the set in `~/.cache/keynote-sets/<project>/set/` and list it in `KEYNOTE.md`.

1. **The whole building, then the floor plan.** Design the entire building the space belongs to,
   not just the courtyard: model it on a real architect's typology (e.g. Rick Joy: rammed-earth bars,
   impassive exterior, life turned inward to a courtyard, glass only onto it, one gate, a carport box).
   Write `program.md`: every room, court, wall and opening with coordinates in metres (origin at a
   courtyard corner, x east, y north). Mirror it in a `layout.json` (boxes + cameras) and draw the plan
   from those numbers (OpenCV or similar: walls, glazing, doors, dimensions, scale bar, north arrow,
   camera markers), so the plan is exact rather than painted. Place the ONE camera that sees the LED
   wall, and every storyboard camera, on it.
2. **Clay view per camera.** `blender -b --python S/set/blockout.py -- layout.json CAM OUT --persp
   1920x1080` renders the massing from each storyboard camera. Check the framing there (is the
   planted subject visible? does the gate line up with the wall behind it?) and move the camera in
   `layout.json`, not in a prompt. Codex CLI image generation for everything that follows:
   `codex exec --skip-git-repo-check --sandbox workspace-write -C W -i clay.png -i plan.png -i ref.png`
   with the prompt on stdin (`-i` swallows a positional prompt); four run in parallel.
3. **Keyframes and angles.** Generate each with its clay view, the floor plan, the look bible and the
   material references attached ("match the clay's framing and geometry exactly; the plan wins"):
   same materials, light and objects. Hero wide: the wall square-on, 16:9, blank white face.
4. **Aerial.** The building the space belongs to, as an architect's work (e.g. "designed by
   Rick Joy: immaculate rammed-earth volumes, perfectly clean flat roofs, no HVAC units, vents,
   solar panels or railings"), placed by the floor plan (camera south of the court looking
   north so the gate and wall face the lens). Generate two; keep the one that matches the plan.
5. **Plate motion** (`S/fal-motion.py PLATE.png OUT.mp4 --duration 10`; `--max --resolution 1080P` for the final, the plate as
   first and last frame; the prompt names only what exists).
6. **Pin and mask** (`S/mask-motion.py PLATE.png CLIP.mp4 OUT.mp4 --rect x0,y0,x1,y1
   --feather 0.012 --length L`): one constant transform, motion interpolation to 30 fps, motion
   kept only inside rects where the model behaves. Look at a crop of every clip at three times
   for invented things (grass blades, a branch sweeping through, a morphing screen); shrink the
   rect or use the still plate for that angle.
7. **Camera** (`S/live-plate.py CLIP_OR_PLATE OUT.mp4 --move push|pull|drift-left|drift-right|rise
   --amount 0.03 --settle 2.4 --length 8 --trim 0`): eases in, then locks. Check
   `S/check-jitter.py OUT.mp4 2.8` < 0.15 px.

## 1b. Experimental: spatially exact sets as a splat world (not the default)

Tried in v16 and not adopted: the result reads CG and needs many iterations. Transitions use
`transitions.md` (storyboarded short shots). The tooling stays for special cases.

Independent image and video generations disagree on geometry (a tree moves, a building
reshapes), and a video model interpolating between them morphs. Instead, make a layout the
single source of truth, paint it from a few cameras, bake the paintings onto its exact geometry
as Gaussian splats, and fly any camera through the result. It costs nothing per shot (Blender +
Codex + a browser renderer; no Fal), and every angle agrees by construction. `S` = `scripts/set/`.

1. **Layout** (`layout.json`, metres, x east / y north / z up): boxes (ground, wall, led, roof,
   column, furniture), trees, seeded scatter (`kind: shrub`), sun, and named cameras
   `{at, look, hfov_deg}`: the hero, the aerial, and a mid-descent station.
2. **Blockout per station** (`blender -b --python S/blockout.py -- layout.json CAM OUT --pano 2048
   --persp 1440x810`): clay renders, exact depth (EXR), object ids. **Render at the bake size**:
   interpolating depth makes floaters.
3. **Paint the stations** (Codex image generation, prompt on stdin, images attached):
   - the 360° panorama (the surroundings) and the aerial: repaint the clay "keeping its geometry
     exactly", with a style reference;
   - every other station (hero, mid): **re-render the existing splat set from that camera** and have
     Codex redraw that soft render sharp ("the same image re-shot with a high-end camera"), with the
     clay attached. Then `S/grade.py SHARP SOFT OUT` (frequency split: detail from the painting,
     colour and light from what the set already is). Stations then match.
   - **clean plates**: ask for plates without thin organic things (trees); they smear when projected.
4. **Elements**: generate each tree isolated on pure white (Codex), `S/key-element.py` → RGBA card.
   The renderer stands it at its layout position as a camera-facing card with a ground shadow
   card cast by the layout's sun, plus a slow wind sway.
5. **Sky**: `S/sky-env.py BLOCKOUT PANO sky.jpg`, an equirectangular dome behind everything (no station
   sees the low sky behind walls). Bake with `--no-sky`.
6. **Bake** (`S/bake.py OUT.ply --station persp:DIR:PLATE … --station pano:DIR:PANO --skip-kinds 3,7,8
   --no-sky`): every pixel at the blockout's exact depth; **the finest sample wins** (footprint = the
   true 3D spacing of its pixels, so grazing views count as coarse); the LED (3) and tree (7, 8) are left
   out (real elements), with a recoloured ring where the painting bled; one PLY per station.
7. **Fly** (`node S/render-splat.mjs A.ply,B.ply,… PATH.json OUT.mp4 [--stills …]`): Spark in headless
   Chromium, deterministic. PATH.json: `keys` (with per-key `hfov`: a gentle lens change keeps the frame
   inside the painted plates), `spline` + `ease: "inout"` for flights, `sky`, `screens` (the LED as a real
   plane: `image` or a power-on/off `sequence`), `sprites` (tree cards).

Bookends from the splat world: the open is the flight + a hold with the screen sequence powering on;
the close is a hold with the screen powering off + the same flight reversed. `bookend.py` and
`drone-join.py` are only for video-model footage.

Checks per iteration: render the hero still and compare against the blockout's edges; render each
station alone from the hero camera (a station that leaks shows up at once); contact-sheet the flight
every ~1 s; `check-jitter.py` on the locked hold.

Gotchas (each cost an iteration):
- The browser renderer crashes above ~1.2–1.5 M splats in view per mesh: persp stations ≤ 1440 px, one
  PLY per station, panoramas sampled by solid angle.
- Cycles writes *planar* depth for perspective cameras and *ray length* for panoramic ones.
- Nearest-neighbour depth resampling shifts samples half a pixel (3% on grazing ground → z-fighting
  streaks); linear resampling makes floaters. Don't resample: render the blockout at the bake size.
- Splat size stays the pixel's *angular* size; only the fusion uses the true footprint (sizing splats by
  it turns grazing surfaces into blobs).
- Fusion coverage must count pixels thinned by solid-angle sampling; foliage pixels that show sky
  through branches must be keyed out.
- The screen's bezel box needs ~3 cm behind the face and a polygon offset: 4 mm z-fights from 100 m.
- Scatter must not share the tree's object kind, or skipping the tree deletes every shrub.
- Transparent overlay meshes (shadow cards) need `renderOrder` after the splats.
- FFmpeg can't read Blender's PNGs (bad eXIf); re-save through OpenCV.
- Playwright lives with `demo-engine`; the importmap must map `three/addons/`.

## 2. Bookends (drone in, drone out; music only here)

Two modes. Pick one per film and storyboard it (`transitions.md`):

| Mode | What it is | Use when |
| --- | --- | --- |
| **A. Single shot** | One continuous generated move between two keyframes (start and end), both painted over clay views of cameras on one path and confirmed correct | The idea is one move (a drone descending over the wall to the hero wall); a short path (≈≤40 m, one direction) where both ends see the same subject |
| **B. Multi-shot** | Several short start-frame-only moves cut together (geography → approach → the hero settling) | Large changes of scale (from the landscape to the wall), or when mode A morphs |

**Keyframes (both modes).** Every keyframe is a camera in `layout.json`: render its clay view
(`blockout.py`), paint over it (section 1, step 3), then confirm it:
`S/set/check-keyframe.py KEY.png blockout/CAM --out check.jpg` must PASS (edges ≥ 0.7 and LED ≥ 0.8,
relative to the clay itself; a painting of another viewpoint scores ~0.4-0.5), and the overlay must
look right (cyan: the camera's outline; magenta: the best fit). A failing frame is regenerated, never
animated. An approved plate already in use (the hero wide) keeps its pixels: fit its camera to it
instead (the checker's best fit gives the zoom and shift; narrow `hfov_deg`, turn `look`), re-render,
re-check.

### Mode A: single shot

1. **Path.** Start and end cameras in `layout.json` on one plausible drone path (the end is usually
   the hero camera). Render both clay views and look at the path in between: the start should
   already show what the end shows (the wall, the tree, the pavilion), only smaller.
2. **Paint the start over its clay with the end frame attached** ("this is the first frame of one
   shot whose last frame is END: same geometry, materials and light"), several candidates at once.
   Keep the one that passes `check-keyframe.py` best; show the start, the end and both overlays to
   the person approving the film before generating.
3. **Generate** (the end frame is the plate, the start frame is `--start-image`):
   `S/fal-motion.py END.png move.mp4 --start-image START.png --duration 6 --prompt "…"`: Turbo at
   480P to test; `--max --resolution 1080P` for the approved final. The prompt describes the path
   only: one continuous stabilized drone take; the camera flies forward and descends over the south
   wall into the courtyard and levels at eye height facing the LED wall; the building is rigid and
   never changes shape; exactly the objects in the frames (name them: "exactly ONE tree"); the wall
   stays a flat blank rectangle; no cuts.
4. **Review** frames every 0.5 s for morphing and invented objects. Then **join**
   (`S/drone-join.py move.mp4 END.png j-in.mp4 --land`, `--leave` for the way out) so the landing is
   pixel-exact on the plate, and retime with `cut-shots.py` if the clip hitches.
5. The way out is the same shot reversed, or its own pair of frames (hero → aerial).

### Mode B: multi-shot

1. **Short shots** from their keyframes, start frame only, move-only prompts:
   `S/fal-motion.py KEY.png shot.mp4 --no-end-frame --duration 6 --prompt "…"` (Turbo at 480P to
   prove the cut; `--max --resolution 1080P` for approved finals). Look at frames every ~0.5 s and
   note where each shot goes wrong: models invent at the frame edges late in a move, and a rise
   reveals what the keyframe never showed (an eye-level plate's rise invented HVAC units on the roof).
2. **Cut them** (`S/cut-shots.py`): the used middle of each shot, hard cuts, 30 fps. The destination
   is the hero plate drifting and settling (`S/live-plate.py HERO.png dest.mp4 --move drift-right
   --amount 0.025 --length 2.6 --settle 2.2`: settled before the wall's 0.4 s dissolve, or the
   dissolve ghosts). The way out ends on the geography shot reversed, easing to a stop:
   `cut-shots.py in.mp4 S1.mp4:1.0:4.5 "S2.mp4:0.8:2.9,crop=0;0;0.95;0.95" dest.mp4:0:2.6` and
   `cut-shots.py out.mp4 O2.mp4:0:1.6 O3.mp4:1.0:4.5 "S1.mp4:0:4.5,reverse,ease=out,len=5,hold=0.6"`.
   H3 delivers 24 fps made by dropping every 5th frame of a 30 fps render (every 4th step moves
   twice as far: a hitch); cut-shots measures the steps and interpolates at the true times.

### Both modes: the wall, the film, the music

1. **Wall on / wall off** (`S/bookend.py open IN.mp4 HERO.png WALL.jpg BG.mp4 open.mp4` and
   `S/bookend.py close OUT.mp4 HERO.png WALL_END.jpg BG.mp4 close.mp4 --off X`). IN/OUT are the
   joined single shot (A) or the cut sequences (B). BG is the hero's pinned motion clip
   (`live-plate.py HERO.png BG.mp4 --move hold --length 13`); X is the close act's last word.
2. **In the film:** the open act's flight shot (`flight: true`) and wall shot are cut from the
   same clip (`from` = the act's `scriptAt` − 0.12); `scriptAt` lands just after the wall is
   lit (bookend.py prints when). The close act: the wall shot, then the flight cut at `{dout}`
   after the last word, with `scriptTail` long enough to finish the drone.
3. **Music** (`S/music.py cue.mp3 --seconds 10 --prompt "…" --envelope`): one cue per drone,
   `music.cues` at `start` and `end`. The voice never starts before the open drone lands.

Model notes: H3 Max invented a tree and let the building change shape over a 10 s move between an
unverified aerial and the hero (v14); Seedance 2.5 held the geometry better but costs ~9x (v15;
`--model seedance`, 1080p can queue 30-60+ min: `--resume <id>`). Unverified keyframes were the
larger cause: confirm both frames first.

## 3. Real UI beats

Record from the project's seeded demo or fixture build (never live data) with
`S/capture/record.mjs` (Chrome virtual time: exact frames, a-ha contract, pointer telemetry).
A flow is `{ theme, root, css, setup, start, park, flow(d) }`; the project passes its own
`open()` (see its `KEYNOTE.md`). Record at 3x, dark, one component isolated on black (`css`).

- **An action on its word** ("open it"): record the real component performing, then frame it
  with `S/reframe.py REC.raw.mp4 OUT.mp4 --key T,X,Y,W[,EASE] … --clip x,y,w,h --pointer
  REC.pointer.json --cursor-from A --cursor-until B --pad-start P --length L`: 16:9 keys in CSS
  px that follow the element (push to it while it's described, widen as it opens, leading by
  ~0.3 s); `--pad-start` so the click lands on its word (`itemAt` from `film.plan.json`).
  Isolation CSS must keep portals (popovers, panels) visible; measure the product's element,
  not a same-named copy elsewhere on the page.
- **Several → choose one → see it** (`pick`): real pieces cut from 3x screenshots by DOM rect:
  rows minus dividers (`rowRadius` makes them cards), the row's real selected state (`sel`),
  and the opened item's real header (with its metadata, e.g. a project chip), body and actions,
  each with its left edge (`header.x`, `detail[].x`) so the film keeps the product's alignment.
- **Choices**: `triptych` with the product's own icons (SVG masks), focus on each name.
- **Sharp stills**: `S/ui-clip.py` keys a captured still onto black for a clip shot.

## 4. Motion graphics

`craft.md` has the idea → motion table. Breadth: `category` + `bleed: true` with real logos,
most recognizable nearest the number. Bento: light field, mixed sizes (`areas`), one motion and
colour per tile; the hero tile is the brand backdrop (a recorded brand plate as `video`, the
real app icon as `img`), never a stock glyph. Big gradient words auto-fit their tile.

## 5. Render, time, validate, review

```sh
S/render.sh FILM.json OUT --lint
S/render.sh FILM.json OUT --narrate          # voice eleven_v4, one take per act (cached)
python3 S/validate-film.py FILM.json OUT     # A1–A11
```

1. Read `OUT/film.plan.json`: every shot's start/duration, `labelAt`, `itemAt`. A first shot
   started by a cue leaves the act's opening words over nothing (A11 catches it).
2. Re-time what depends on words (reframe `--pad-start`, bookend `--off`) and re-render.
3. Contact sheets: a mid frame of every shot, and frames through every motion sequence and
   every handover (row → header, pill → panel, wall on/off, drone joins). Score R1–R12 strictly
   in `review.json` (1 when anything is missing).
4. `validate-film.py FILM.json OUT --review review.json` until OVERALL PASS. Publish the MP4
   with `validation.json` and `review.json` (e.g. `~/Movies/<Project> Keynotes/<version>/`).

## Lessons (why each rule exists)

| Seen | What went wrong | Rule |
| --- | --- | --- |
| v7–v9 | Slides, stock rooms, fake devices | One generated place, many planned angles; real product UI |
| v11 | Plates jittered | One constant pin transform, motion interpolation, clips longer than the shot |
| v12 | White rim / artifact at the wall's corner | Grow the wall quad (`--bleed`); keep generated motion off the wall |
| v13 | Empty environment shot; black screen mid-film | R11 purpose + A11 empty-frame gate |
| v13 | Music under the voice | Music only over the drones, before and after the voice |
| v13 | Coloured bars that never became the UI | UI beats are real recordings or morphs that land on the real element (R12) |
| v13 | A text list for three modes | The product's own glyphs, focus on each name |
| v13 | Logos in a small grid | Bleed past every edge; big tiles |
| v13 | Equal dark bento cards | Apple bento: mixed sizes, one motion and colour per tile |
| v14 | Drone over a generic house with rooftop HVAC units | Aerial as an architect's clean work, placed by the floor plan |
| v14 | Turbo footage | Ship H3 Max (`--max`); Turbo (the default) for prompt and pipeline tests |
| v14 | A gradient word lost its last letter | Gradient text fits its tile (`background-clip: text` cuts overflow) |
| v14 | Bento hero with a stock glyph | The brand backdrop + the real app icon |
| v14 | Rows squared off with dividers; opened header off-axis; missing metadata | Real pieces with real states, offsets and metadata |
| v15 | H3 drone invented a tree; the building changed shape mid-flight | Drone moves on Seedance 2.5 with a rigid-geometry, exact-objects prompt |
| v15 | Recorder stalled on a static page | The recorder keeps a compositor animation running and never blocks on input acks |
| v16 | Drone shots from video models drifted and morphed; stations disagreed | One layout → painted stations → splat world; fly real cameras through it (section 1b) |
| v17 | Seedance 2.5 single shot on OpenRouter: A1 → hero, 8 s, 720p, no audio, $1.86 | The best result: one rigid building and ONE tree throughout, a clean pass through the gateway, natural texture, no dropped frames, and both ends exact (0 px, scale 1.000: no join needed). Only limit: 720p on OpenRouter (upscale.py → 1080p, or Fal at 1080p for $1.40/s) |
| v17 | Veo 3.1 Lite test: single shot A1 → hero (8 s) and S2 (6 s), 1080p, $0.70 | Rejected by the user as ugly. Smooth single shot through the gate, no dropped frames, far sharper than H3; but the tree doubles for ~1 s before the landing, gravel and earth read over-sharpened at 100%, the landing is ~10 px / 1.6% off the plate (join it), and S2 invents walls after ~2.5 s |
| v17 | HeyGen Video 1 test (S1, S2 at 480p, $0.06 each) | Same building rigidity and the same invented wall at S2's right edge after ~3 s as H3; weaker on a slow push (S1 moved ~0.4 px/f vs H3's 1.0). Use it for cheap multi-shot tests |
| v17 | Single shot from unverified frames morphed; the old aerial was 2% off its camera | check-keyframe.py confirms both frames (A1 painted over its clay: 0-2 px off); the Turbo 480P test held the building for the whole descent, only the tree reshaped in the last 1.5 s. 480P output is 832x480: a uniform ~2% crop at both ends that the join absorbs |
| v17 | Intro/outro shots hitched every 4th frame; a rise off the hero invented roof HVAC | cut-shots.py retimes dropped frames; use each shot's middle and stop before the model reveals the unseen |
| v17 | Splat world read CG; keyframes painted from a courtyard-only plan disagreed about the building | Whole-building plan drawn from coordinates + a clay view per storyboard camera; keyframes painted over the clay (section 1) |
| 0.5.0 plates | Procedural sets (WebGL, Cycles) read CG and a themed landscape felt silly; video models morph | Relit the approved courtyard to dusk by editing its plates (geometry kept), wall-off twins ≤0.5 px, drone as a plate funnel, everything moving composited in code |
| 0.5.0 code set | A first WebGL-only test drew its own cards on the wall, wrote a per-line voice script and skipped the engine: it read as slides, stilted, disconnected from the product | A code-built set replaces only the location (clips rendered from cameras in it); the film still goes through the engine with v15's grammar, one take per act, and real UI pieces. Real components without live data come from the workbench stories (`packages/demo-engine/experiments/constellation-set/ui-pieces.mjs`) |
| v15 | ~$28 of Seedance at 1080p + high bitrate, two at once, without a price check; ~32 Fal clips over the series, many exploratory reruns at 1080p; the account locked with a paid drone-in unfetchable | Money rules above: approved budget, `--estimate`/`--max-cost` guard, 480p single tests, reuse and edit before generating |
