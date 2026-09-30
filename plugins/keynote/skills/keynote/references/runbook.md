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
List prices (2026-09-29; H3 doubles after its launch promo ends 2026-09-30):

| Model | 480p | 720p/768p | 1080p | A 10 s clip at 1080p |
| --- | --- | --- | --- | --- |
| H3 Max Turbo | $0.025/s | $0.04/s | $0.08/s | $0.80 |
| H3 Max | $0.05/s | $0.08/s | $0.16/s | $1.60 |
| Seedance 2.5 | $0.26/s | $0.57/s | $1.40/s | $13.96 |

Rules:
1. **No generation without an approved budget.** Before any Fal call, show the person paying the
   list of clips with `fal-motion.py … --estimate` totals and get a yes. `fal-motion.py` refuses
   any request estimated over `--max-cost` (default $1) and logs every submission to
   `~/.config/recursive-keynotes/fal-ledger.jsonl`.
2. **Reuse before generating.** The set, plate motion and drone moves carry across films: check
   the project's set folder first. A drone-out played in reverse is a drone-in on the same path.
3. **Test cheap, once.** Prove a prompt with ONE clip at 480p (turbo for H3; `--seedance-res 480p`
   for Seedance), 4–5 s. Only the approved final goes to 1080p, and never two at once.
4. **Don't regenerate to fix what editing can fix** (masking, pinning, trimming, reversing).
5. When the account locks (`User is locked`), stop: a finished request's result cannot be fetched
   until the balance is topped up; `--resume <id>` fetches it afterwards.

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

Keep the set in `~/.cache/keynote-sets/<project>/set/` and list it in `KEYNOTE.md`.

1. **Layout, then floor plan.** Write the zones (a hero wall stage, a garden, a wall walk, a
   pavilion, a gate) and the ONE camera that sees the LED wall. Generate a top-down floor plan
   with camera markers (Codex CLI image generation: `codex exec --skip-git-repo-check
   --sandbox workspace-write -C W -i ref.png` with the prompt on stdin; `-i` swallows a
   positional prompt).
2. **Angles.** Generate each angle with the establishing plate AND the floor plan attached:
   same materials, light and objects. Hero wide: the wall square-on, 16:9, blank white face.
3. **Aerial.** The building the space belongs to, as an architect's work (e.g. "designed by
   Rick Joy: immaculate rammed-earth volumes, perfectly clean flat roofs, no HVAC units, vents,
   solar panels or railings"), placed by the floor plan (camera south of the court looking
   north so the gate and wall face the lens). Generate two; keep the one that matches the plan.
4. **Plate motion** (`S/fal-motion.py PLATE.png OUT.mp4 --duration 10`, H3 Max, the plate as
   first and last frame; the prompt names only what exists).
5. **Pin and mask** (`S/mask-motion.py PLATE.png CLIP.mp4 OUT.mp4 --rect x0,y0,x1,y1
   --feather 0.012 --length L`): one constant transform, motion interpolation to 30 fps, motion
   kept only inside rects where the model behaves. Look at a crop of every clip at three times
   for invented things (grass blades, a branch sweeping through, a morphing screen); shrink the
   rect or use the still plate for that angle.
6. **Camera** (`S/live-plate.py CLIP_OR_PLATE OUT.mp4 --move push|pull|drift-left|drift-right|rise
   --amount 0.03 --settle 2.4 --length 8 --trim 0`): eases in, then locks. Check
   `S/check-jitter.py OUT.mp4 2.8` < 0.15 px.

## 1b. Spatially exact sets (blockout → panorama → splat; no video model)

Independent image generations disagree on geometry (the tree moves, walls change), and a video
model interpolating between them morphs. Make the layout the source of truth instead:

1. **Layout spec** (`layout.json`, metres, x east / y north / z up): boxes (ground, walls, LED
   wall, roofs, columns, furniture), trees, sun, named cameras `{at, look, hfov_deg}`.
2. **Blockout** (`blender -b --python S/set/blockout.py -- layout.json C0 OUT --pano 2048`):
   equirectangular clay panorama, exact per-pixel distance (EXR), object ids, and the camera's
   perspective view.
3. **Paint it** (Codex image generation, prompt on stdin, the clay panorama + a material
   reference attached): "repaint Image 1 photorealistically, keep its geometry exactly". Check
   the blockout's edges over the result; Codex holds walls/LED/pavilion to a few pixels.
4. **Splat** (`S/set/pano2splat.py OUT PANO.png OUT/set.ply`): every pixel at the blockout's
   distance, coloured by the painting; sampled by solid angle (uniform equirectangular sampling
   doubles the count and crashes the browser renderer).
5. **Fly** (`node S/set/render-splat.mjs set.ply path.json out.mp4 [--stills …]`): Spark in
   headless Chromium, deterministic, keyed camera path on the keynote ease.

Measured (courtyard C0, 2026-09-29): the splat lands on the blockout edges; a 3 m push with a
0.6 m slide holds geometry with real parallax and no morphing; cost $0. Limits: one panorama
supports moves of a few metres (occluded areas open up beyond), and it is soft at a 70° lens (a
360° image spreads ~1800 px over the sphere, a fifth of what a 1080p frame needs). Next: project
a high-res perspective plate from the shot camera onto the same geometry for the frustum, add
capture cameras for larger moves, and restyle the aerial from the blockout's own aerial camera.

## 2. Bookends (drone in, drone out; music only here)

1. **Drone moves on Seedance 2.5** (rigid architecture between the anchors; H3 invented a tree
   and let the building change shape):
   `S/fal-motion.py WIDE.png in.mp4 --model seedance --start-image AERIAL.png --duration 10 --prompt "…"`
   and the reverse (`AERIAL.png` as the plate, `--start-image WIDE.png`) for the way out. The
   prompt: one continuous stabilized drone take; the building is rigid and never changes shape;
   exactly the objects in the images (name them: "exactly ONE tree, in the west garden"); the
   wall a flat blank rectangle; the path (over the gate, level at eye height facing the wall).
   Review frames every second for added objects and morphing before joining. Seedance at
   1080p can take 30–60+ minutes in fal's queue: run both moves in the background, keep
   working, and if a run stops, `fal-motion.py … --resume <id>` (the id is in `OUT.fal.json`).
2. **Join** (`S/drone-join.py in.mp4 WIDE.png j-in.mp4 --land`, `--leave` for the way out):
   ramps the residual scale/offset so the landing is pixel-exact on the plate.
3. **Wall on / wall off** (`S/bookend.py open j-in.mp4 WIDE.png WALL.jpg BG.mp4 open.mp4` and
   `S/bookend.py close j-out.mp4 WIDE.png WALL_END.jpg BG.mp4 close.mp4 --off X`). BG is the
   hero wide's pinned motion clip; X is the close act's last word (from the plan, step 5).
4. **In the film:** the open act's flight shot (`flight: true`) and wall shot are cut from the
   same clip (`from` = the act's `scriptAt` − 0.12); `scriptAt` lands just after the wall is
   lit. The close act: the wall shot, then the flight cut at `{dout}` after the last word, with
   `scriptTail` long enough to finish the drone.
5. **Music** (`S/music.py cue.mp3 --seconds 10 --prompt "…" --envelope`): one cue per drone,
   `music.cues` at `start` and `end`. The voice never starts before the open drone lands.

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
| v14 | Turbo footage | Ship H3 Max; turbo only for prompt tests |
| v14 | A gradient word lost its last letter | Gradient text fits its tile (`background-clip: text` cuts overflow) |
| v14 | Bento hero with a stock glyph | The brand backdrop + the real app icon |
| v14 | Rows squared off with dividers; opened header off-axis; missing metadata | Real pieces with real states, offsets and metadata |
| v15 | H3 drone invented a tree; the building changed shape mid-flight | Drone moves on Seedance 2.5 with a rigid-geometry, exact-objects prompt |
| v15 | Recorder stalled on a static page | The recorder keeps a compositor animation running and never blocks on input acks |
| v15 | ~$28 of Seedance at 1080p + high bitrate, two at once, without a price check; ~32 Fal clips over the series, many exploratory reruns at 1080p; the account locked with a paid drone-in unfetchable | Money rules above: approved budget, `--estimate`/`--max-cost` guard, 480p single tests, reuse and edit before generating |
