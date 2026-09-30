# Craft: what makes it a keynote

Measured from Apple's films (`research/`) and from our own review rounds. `motion-policy.md`
is authoritative for motion: cut by default; animate only when the motion demonstrates the
claim, explains a spatial relationship, or points attention at one thing.

## Story

- Open on a problem the viewer has; each chapter answers one question. The picture carries the
  detail, the voice says it plainly.
- One continuous take per act, first person plural, present tense, concrete verbs, no hype
  adjectives without a measurable claim. Phrases ≤ 12 words. Numbers only from the notes.
- On-screen lines reinforce with different words from the voice ("Commits follow the turn.").
- Every shot drives the story. Nothing decorative, no empty scenes, no black frames.
- Close the loop: every motion graphic and demo ends on the answer, shown in the real product.

## The place

- One location for the whole film; every environment shot is a planned angle of it; the LED
  wall appears only in its hero framing, square-on, 16:9.
- Section titles and hero numbers go over angles of the space (centre labels), on screen from
  the shot's first frame (the cut is the reveal).
- Cameras ease in fast and lock (settle ~2.4 s, then hold). Nothing creeps until the cut.
- Music plays only over the drone bookends, before and after the voice, ending cleanly.

## Motion expresses the idea

| Idea | Motion | Example |
| --- | --- | --- |
| "There are several / over time" | Items arrive in order (stagger 0.12–0.18 s, critically damped) | Inbox rows arrive |
| "Choose one" | The chosen item takes its real selected state; the rest recede to ~40% on the word | A message selected |
| "What it did" | The pick becomes the real header in place; the answer builds beneath it; the camera reframes and locks | The opened report |
| "Open it" | The real component performs (recording), the camera follows it as it grows | Pill → panel |
| "Choose a level" | The product's own glyphs, large; a focus ring moves on each name | Permission modes |
| "So many" | The number settles once; logos/names fill around it, most recognizable nearest; past the frame edges | 300+ plugins |
| "Here's the data" | Bars build once, or the chart is final and the camera moves; never both | Plugins by category |
| "And so much more" | Apple bento: mixed sizes, one idea, motion and colour per tile, the brand as the hero | Minor features |

Rules: one motion idea per section. Text never re-animates or scales continuously; a drift
moves the layer, not the type. Motion settles without bounce; handoffs 0.6–0.8 s on the keynote
ease. Use the product's own colours and glyphs for the things they represent.

## Seamless UI

- Bias to the real components: capture real states (selected, hover-free), real metadata
  (chips, timestamps), real alignment. Crop list chrome that reads wrong in isolation (row
  dividers) and round rows only when the product's own selected state is rounded.
- A shape that morphs must start exactly on the real element (same rect, radius, colour) and
  hand over to the real element in place, with something on screen throughout.
- The cursor appears when it moves and fades after the click; nothing hovers by accident.
- UI is captured at 3x and shown at ≤ 2x; type reads at ~40 px at 1080p.

## Typography

Brand display face for titles and labels (from the profile). One size per role. Lint and the
renderer's text guard fail any clipped or off-frame text; gradient words fit their box.
