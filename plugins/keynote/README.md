# Keynote

`/keynote` produces an Apple-style announcement film for any project's update: a script that
answers the viewer's questions, one generated location with drone bookends and a video wall,
real UI beats recorded from the product, motion graphics, voice and music, rendered by the
keynote engine (`@recursive/demo-engine`) and validated against a quality rubric.

| Path | What |
| --- | --- |
| `skills/keynote/SKILL.md` | The contract: what a film must be, and when it is done |
| `skills/keynote/references/runbook.md` | The procedure, step by step, with commands and the lessons table |
| `skills/keynote/references/{quality-rubric,craft,film-format,motion-policy,project-profile}.md` | Rules, film JSON, the per-project `KEYNOTE.md` template |
| `skills/keynote/references/research/` | Frame-level studies of Apple's films behind the rules |
| `skills/keynote/scripts/` | `fal-motion.py` (H3 Max plate motion, Seedance 2.5 drone moves), `mask-motion.py`, `live-plate.py`, `composite-plate.py`, `drone-join.py`, `bookend.py`, `reframe.py`, `ui-clip.py`, `music.py`, `check-jitter.py`, `validate-film.py`, `render.sh`, `capture/record.mjs`, `set/` (blockout.py, pano2splat.py, render-splat.mjs: spatially exact splat sets) |

Each project keeps a `KEYNOTE.md` profile (brand, voice, how to open the product for
recording, the set). Recursive's is `websites/recursive/scripts/keynotes/KEYNOTE.md`.

Requirements: ffmpeg, Python 3 with `opencv-python` and `numpy`, Node with Playwright, the
keynote engine (inside a Recursive checkout it is found automatically; elsewhere set
`KEYNOTE_ENGINE` to `packages/demo-engine`), Codex CLI for image generation, `ELEVENLABS_API_KEY`
and `FAL_KEY` in the environment (never in a repository).
