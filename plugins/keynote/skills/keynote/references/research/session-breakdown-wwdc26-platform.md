# Session breakdown: WWDC 2026 keynote, "Platform improvements" chapter

A frame-level study of one complete product session (11 min 52 s, keynote
05:04–16:56). The goal is to explain why Apple's non-presenter footage feels
smooth, measured rather than guessed. The notes, descriptions and numbers are
ours; no footage or transcript is kept in the repository.

## Method

- Source: 640×360 at 30 fps, the highest rendition available to the downloader
  at the time. That is enough for timing, motion and easing, but not for
  pixel-level typography.
- `frames.py` (OpenCV) measured all 21,360 frames. Per frame it records luma,
  saturation, frame difference and HSV-histogram distance, plus the global
  similarity transform from the previous frame (ORB features + RANSAC → scale,
  rotation, pan). From these it derives:
  - hard cuts (isolated histogram spikes);
  - soft transitions (sustained blend-like change);
  - camera moves inside shots, each with a normalised velocity profile:
    time-to-peak and the 10%/90% progress points.
- Every one of the 81 shots was labelled by eye from first/middle/last-frame
  sheets. Nine key sequences were read at 10 fps.
- Audio: 50 ms RMS against caption word timings, which separates speech from
  the gaps between words.

## The numbers

| Measure | Value |
| --- | --- |
| Shots | 81 (80 hard cuts) |
| Presenter-to-camera share | 49.6% of runtime (excluded from the rest of this study) |
| Dissolves *between* shots | ~0 (one, presenter to presenter) |
| Non-presenter runs between presenter shots | 25; median 11 s, longest 53 s |
| Median shot length: device on white / Mac screen / motion graphic | 11.1 s / 11.1 s / 9.9 s |
| Median shot length: UI close-up montage | 1.47 s (1.23–1.5 s each) |
| Section title card | 1.5–3.7 s, **completely static**, hard cut in and out |
| Camera push/pull duration (49 moves) | median **1.1 s** (0.4–3.3 s; fly-throughs to 18 s) |
| Camera velocity peak | median at **35%** of the move: fast attack, long settle |
| Progress at 10% / 90% | typically 0.05–0.15 / 0.55–0.9 of the move time |
| Largest in-shot zooms | 14× (through type into UI), 13× (Mac into abstract UI), 9× pull-back (feature wall) |
| Voice level (speech frames) | −22.7 dBFS median |
| Level in pauses between words | −31.3 dBFS median: **music is always playing** |
| Near-silence (< −55 dB) | 2.3% of runtime |
| Level jump at cuts | smaller than at random moments: no whooshes or SFX |

## What the footage actually does

### 1. Cuts are hard; motion does the smoothing
There are almost no dissolves between shots. Smoothness comes from three
things inside the shot:
- **Cut into motion.** A shot's first frame is already moving: a push into a
  Mac starts on the cut and has covered most of its distance about 0.5 s later.
  A shot never starts from rest.
- **Carry motion across the cut.** A pull-back that ends one shot continues on
  the next: the Mac pulls back out of frame, and the cut lands on an iPhone
  that is already pulling back and settling.
- **Morph instead of cutting.** One element becomes the next in a single shot.
  3D glass lettering is flown through into a slider, the slider knob becomes a
  toggle, and the toggle flips (6.2 s, no cut).

### 2. Camera: fast push, then stillness
- A push covers most of its distance in the first third (peak velocity at
  about 35%) and settles slowly. Symmetric ease-in-out (peak at 50%) reads as
  mechanical by comparison.
- Fast moves carry visible **motion blur**.
- After a push the camera **holds still** while the UI performs: taps,
  scrolling, a slider moving. The camera moves *between* beats, not during
  them. There is no constant drift.
- Typical move: device on white → push into the screen's lower third (3× in
  0.4–0.9 s) → hold 2–3 s while the UI animates.

### 3. Sets for UI (not the presenter's room)
- The neutral field is an **off-white infinity**, about #F0F0F2–#F4F4F6
  (measured luma 231–240, saturation < 10). It is not a coloured gradient.
- Devices float on it at a modest size, centred, with no visible drop shadow.
- A Mac appears as the whole laptop on white, then the camera pushes until the
  app window fills the frame. The desktop wallpaper stays visible at the edges.
- UI close-ups crop a single control (tab bar, camera modes, call slider,
  player) to 3–4× and let it animate. Real photographic content sits behind
  the translucent UI. Each lasts 1.2–1.5 s and is cut on the music.

### 4. Motion graphics vocabulary
- **Section card:** one or two words in a dark, subtly tinted gradient on the
  off-white field. Static. 1.5–3.7 s.
- **Accumulating feature wall:** feature names sweep in horizontally, one line
  at a time (about 0.3 s each, heavy motion blur), and settle into rows. The
  camera pulls back 9× over 5 s so the wall keeps growing.
- **Stat + list:** a big number on the left ("Up to 30%") beside a long list
  of improvements on the right. The list scrolls to highlight the next item
  and the number changes (30% → 70% → 80% → 5×). One continuous 20 s shot.
- **Explainers:** flat, monochrome diagrams on light grey (bars, card stacks)
  with pushes into their details.
- **Fly-through to abstraction:** a push into a real app keeps going past the
  screen, blurs, and emerges as a field of wireframe UI cards floating on
  white. That field later becomes a single card again.

### 5. Sound
- A continuous music bed sits about 8–9 dB under the voice and fills every
  pause, so there is never dead air.
- No transition sound effects.

## Gap analysis against our v2 film

| Ours (v2) | Apple | Change |
| --- | --- | --- |
| Symmetric smootherstep camera | Fast attack, long settle (peak ≈ 0.35) | New ease curve, measured |
| Shots start at rest, then move | Shots start mid-move | Entrance moves begin before the cut |
| Constant slow drift | Push, then hold still | Remove drift; move between beats |
| No motion blur | Blur on fast moves | Sub-frame accumulation on moving frames |
| Chapter titles build word by word on gradient fields | Static section cards on off-white | Static card style |
| Virtual room with a wall | Off-white infinity, floating devices, Mac push-in | Laptop frame on off-white; push into screen |
| Dissolves between shots | Hard cuts + in-shot motion; fly-throughs | Fly-through transition; cuts elsewhere |
| Feature wall fades in | Lines sweep in and accumulate during a pull-back | Accumulating wall |
| Silence between lines | Continuous music bed at about −9 dB | Music bed, ducked under the voice |
| No close-ups | 1.2–1.5 s UI close-up montages on the beat | `macro` montage shot |

## Benchmark: our v3 film measured with the same tools

`frames.py` and the voiced-frame/pause audio method were run on the rendered
0.1.33 film (downscaled to 640×360 at 30 fps for parity).

| Measure | Reference session | v3 film |
| --- | --- | --- |
| Between-shot transitions | hard cuts, ~0 dissolves | 19 cuts, 1 soft (fly-through) |
| Push/pull duration (median) | 1.1 s | 0.95 s |
| Velocity peak (fraction of move) | 0.35 | 0.31 |
| 10% / 90% progress | 0.11 / 0.73 | 0.10 / 0.77 |
| Voice-to-bed gap | 8.6 dB | 8.6 dB (bed gain −20 dB, calibrated) |
| Near-silence | 2.3% | < 1% |

### Measurement pitfall
Speech windows must come from *voiced frames*, not whole narration clips.
Generated lines contain their own pauses, and counting those as speech makes a
loud bed look quiet. Calibrate the bed against voiced-frame medians and pauses
≥ 0.8 s, the same way the reference was measured.

## Still different from the reference (needs new footage, not code)
- Captures are 1× browser recordings; Apple's UI close-ups are crisp at 3–4×.
  Recording at `deviceScaleFactor: 2` would close most of this gap.
- Apple morphs *designed* elements (glass letters into a slider). Ours can only
  fly through between shots. True morphs need per-feature motion design.
- Lifestyle footage and product films have no equivalent here.
