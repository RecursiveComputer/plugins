# Transitions: storyboard → keyframe images → short video shots

How Apple moves the audience from one place to another, measured frame by frame, and the rules
that turn that grammar into prompts an image model and a video model can execute. Use it for the
drone intro and outro and for any change of location.

## What the footage does

### Presenter handoff: Apple Event, Sept 9 2024, 20:08–20:22 (Golden Gate → Golden Gate Park)

Cuts and camera motion were measured frame by frame (cut detection plus a similarity fit between
consecutive frames; px/frame at 1080p).

| # | Time | Length | Picture | Camera (measured) | Ends |
| --- | --- | --- | --- | --- | --- |
| 1 | 20:08.0–20:12.5 | talk, then a 1.7 s move from 20:10.8 | Presenter A, landmark (bridge) behind | Locked while she talks; then rises and tilts up with a slight bank (tilt ≈ +3 px/f, roll +3.5°) as she leaves frame | Cut **mid-move**, composed on the landmark: tower on the right third, horizon near the upper third |
| 2 | 20:12.5–20:15.9 | 3.4 s | Aerial of the city in morning fog, second landmark (Sutro Tower) on the top-third crossing | Push forward (+11% scale over the shot) with a left drift that accelerates into the cut (0 → −3.7 px/f) | Cut **mid-move** |
| 3 | 20:15.9–20:19.3 | 3.5 s | Park establishing: tall trees against the sky, long shadows across the lawn toward camera | Truck/pan right, accelerating (2.6 → 6.8 px/f), slight push | Cut **mid-move**; presenter B is **already in frame**, small, walking in the distance |
| 4 | 20:19.4–20:22.5 | ≈3 s to settle | Presenter B walking toward camera, horizon on the upper third | Dollies back as he approaches, pans right, **decelerates to a stop** (4.9 → 0.3 px/f) | Settles; lower-third name |

### Event open: same event, 2:09–2:31 (film → Apple Park → stage)

Tilt up into the sky at the end of the previous film (2:09.5) → sky hold, a match cut hides the change
of place (2:10–2:16) → tilt down onto the campus from high up (2:16.5–2:18) → slow drone push toward
the ring (5 s) → cut to the facade close (2:23) → fly-through the glass, the fast move hides the join
(2:24–2:25.5) → low glide across the lawn to the stage (5 s) → hard cut to the presenter, locked (2:31.5).

### The grammar

1. **A funnel of scale:** landmark or wide geography → where we are (aerial) → the new place's
   establishing shot → the subject. Every shot answers "where are we now?" at a smaller scale.
2. **Short shots, one dominant move each:** 1.5–5 s. Push, drift, truck, tilt or crane, sometimes with
   one slight secondary move. Speeds are slow: 1–7 px per frame at 1080p.
3. **Cut on motion:** linking shots start already moving and are cut while still moving (often
   accelerating into the cut). Only the destination shot eases out and settles.
4. **Screen-direction continuity:** consecutive moves share a direction (shots 3 → 4 both move right),
   or the change is motivated (rise → aerial).
5. **Plant the destination:** the subject of the next shot is already visible in the last linking shot
   (the presenter walking in the distance). The cut then feels like moving closer, not jumping.
6. **Hide joins in texture:** sky, fog, glass and fast motion carry the cut between places.
7. **One light:** same time of day, sun direction, sky and grade in every shot. Long shadows give
   the shots depth and tie them together.
8. **Composition:** horizon on the upper third in aerials and destination shots; the landmark on a
   third; layered depth (foreground / middle / background) so any move shows parallax.

## Two modes

- **Single shot:** one continuous move between two keyframes. The start and end are cameras on one
  path in the layout; both are painted over their clay views and pass `check-keyframe.py` before the
  video model sees them; the video prompt describes the path. Best for a short, one-direction move
  where both ends show the same subject (a drone descending over the wall to the hero).
- **Multi-shot:** the grammar above: several short start-frame-only moves cut on motion. Best for a
  large change of scale, and as the fallback when a single shot morphs.

## Rules for the images (keyframes)

A video model animates the image it's given. Design each keyframe for the move it will make.

1. **Storyboard before images.** For each shot write: purpose in the funnel, the move (one verb,
   direction, speed), length used in the edit, how it ends (cut on motion or settle), and what is
   planted for the next shot. Only then write the image prompt.
2. **One place, one light, one bible.** Every image prompt carries the same look bible: location
   description, time of day, sun azimuth and elevation, sky, lens, grade. Attach the approved
   reference images (the establishing aerial, the hero plate, the floor plan) to every generation,
   plus a clay view rendered from that shot's camera (runbook §1): the image model then paints
   over exact geometry instead of inventing the building from each viewpoint. Confirm each frame
   with `scripts/set/check-keyframe.py` before animating it.
3. **Compose the start frame for the move.** Leave room in the direction of travel: a truck right
   starts with open space and the next landmark entering on the right; a push centres the target with
   clear layers in front of it; a tilt down starts in sky with the horizon near the bottom edge.
4. **Depth layers on purpose:** a foreground element (shrub, wall edge, rock), a middle (the building),
   a background (mesas, sky). That's where parallax, and the sense of a real camera, comes from.
5. **Plant the next shot:** put the next shot's subject in this frame, small and on the side the
   camera is moving toward.
6. **Avoid what video models break:** text and signage, thin wires and railings, fine repetitive
   patterns at the frame edges, reflections, crowds, hands. Keep them out, or large and simple.
7. **Nothing the move must invent at an edge:** if the camera will reveal something, show enough of it
   in the start frame (the model extends what exists, it invents what doesn't).
8. **Resolution and format:** 16:9 at the model's native size (1080p class); no borders, no watermark.

## Rules for the video prompts

1. **Describe the move, not the scene.** The image carries the scene. The prompt is: shot type,
   the one move with direction and speed ("slow push forward with a gentle drift to the left"),
   "one continuous stabilized take", what moves in the world (fog, leaves, light), and what must not
   happen ("no new objects, no people, no cuts, the architecture stays rigid").
2. **Start frame only for linking shots.** Anchoring both ends over a long move forces the model to
   morph. Use an end frame only for a short move that must land exactly on a known frame (a settle
   onto the hero plate), and keep that change small.
3. **Generate longer, use the middle.** Generate 5–6 s and cut 2–3.5 s from the middle, after the
   model's ease-in and before it slows or degrades. That's also what makes the cut land on motion.
4. **Short beats long.** Several 3 s shots joined by cuts read better, and warp less, than one long
   continuous move.
5. **Match in the edit:** grade every shot to the hero, add the same grain, cut on motion, keep screen
   direction, and let only the destination settle.
6. **Money:** estimate every clip first (`fal-motion.py --estimate`) and get the total approved. Test the
   first shot at the cheapest setting before generating the rest.

## Storyboard template

```
Shot N — <funnel role: geography | approach | establish | destination | exit>
  Picture:        <what the frame shows; planted subject for the next shot>
  Composition:    <horizon line; landmark position; foreground / middle / background>
  Move:           <verb + direction + speed>; <secondary move, if any>
  Edit:           <seconds used>; <cut on motion | settles>; <direction into the next shot>
  Keyframe:       <start frame; end frame only if it must land exactly>
  Image prompt:   <look bible + composition + the planted subject>
  Video prompt:   <move-only prompt + world motion + negatives>
```
