---
name: keynote
description: >
  Produce an Apple-style announcement film for a product update in any project: a script
  answering the viewer's questions, one generated location with drone bookends and a video
  wall, real UI beats recorded from the product, motion graphics, voice and music, rendered
  and validated against a quality rubric. Use when the user asks for a launch or release
  video, a keynote, an "Apple-style" announcement, or /keynote. Not for a quick narrated
  walkthrough or product stills.
compatibility: >
  ffmpeg/ffprobe, Python 3 with opencv-python and numpy, Node with Playwright, the keynote
  engine (@recursive/demo-engine; set KEYNOTE_ENGINE outside a Recursive checkout), Codex CLI
  for image generation, ELEVENLABS_API_KEY (voice eleven_v4, Music v2.5), FAL_KEY (video).
metadata:
  capture-kind: keynote
---

# /keynote

Make the film the way `references/runbook.md` says, step by step. It is the whole procedure,
with the command for each step and the check that must pass before the next. This page is the
contract; the runbook is the how.

`<skill>` below is this skill's directory (the folder holding this file). Its `scripts/` hold
every tool the runbook names; `references/` hold the rules and the research behind them.

## Before anything

1. **Read the project profile.** Look for `KEYNOTE.md` in the project (root, `docs/`, or a
   `keynotes/` folder). It names the brand (fonts, icon, colours, brand backdrop), the voice,
   how to open the product for recording (a seeded demo or fixture account, never live user
   data), the capture flows, and the set. If there is none, write one with the user from
   `references/project-profile.md` and save it before producing anything.
2. **Collect the update.** Release notes, changelog, or the merged work since the last
   release. Every claim and number in the film comes from there.
3. **Scratch outside the repo:** `~/.cache/keynote-sets/<project>/<version>/`. Reference
   footage for style study stays out of the repo too, and is deleted after study.
4. **Keys never enter the repo.** `FAL_KEY` lives in `~/.config/recursive-keynotes/fal.env`
   (or the environment); ElevenLabs from the environment or the project's `.env`.

## The film (non-negotiables)

- **Script first.** Open on the questions the viewer has about the update; each chapter
  answers one. Each act is one continuous voice take with cues (`references/film-format.md`).
- **One place.** A single generated location, many planned angles, one LED wall seen only in
  its hero framing. Floor plan first; every angle generated from the establishing plate and
  the plan.
- **Drone in, drone out, music only there.** An establishing aerial (the building as an
  architect's clean work), a drone move onto the hero wide, the wall powers on, then the
  voice. At the end the wall says it's available, powers off, and the drone leaves.
- **Every shot has a purpose.** No empty cutaways, no black frames. Environment shots carry a
  section title, the wall, or a drone move.
- **The real product, performing.** UI beats are recordings of the real UI or morphs that
  land exactly on the real element: real states, real offsets, real metadata. Never a stand-in
  that doesn't become the product.
- **Motion expresses the idea** (`references/craft.md`): several → one → what it did;
  choices as the product's own glyphs; breadth that bleeds past the frame; an Apple bento
  whose hero tile is the brand.
- **Money first:** generated video is billed per second (Seedance 1080p ≈ $14 per 10 s clip).
  Never call Fal without the user's approval of an estimated total (`fal-motion.py --estimate`);
  reuse the project's existing set and drone footage, test one cheap 480p clip, and edit
  (mask, trim, reverse) before regenerating. See the runbook's money rules.
- **Video generation:** plate motion on Fal MiniMax H3 Max; drone moves on Seedance 2.5
  (`fal-motion.py --model seedance`), which keeps architecture rigid between the anchor
  images. `--turbo` is for testing prompts only; never ship turbo footage.

## Done means validated

A film ships only when `scripts/validate-film.py FILM.json RENDER_DIR --review review.json`
prints OVERALL PASS (`references/quality-rubric.md`: automated gates A1–A11, review R1–R12
scored strictly from a contact sheet through every shot and handover). Publish the MP4 with
`validation.json` and `review.json`, and report the path, the runtime and anything scored
below 2.

When the user gives feedback, fix it, then add the lesson to the runbook's lessons table
(and to the project profile if it is project-specific), so the next film starts from it.
