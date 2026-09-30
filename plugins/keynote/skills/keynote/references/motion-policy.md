# Motion policy: when things move, and how

This is the `keynote` renderer's animation heuristic. It is derived from
frame-level reads of two sessions: WWDC 2026 "Platform improvements" and the
September 2024 event's iPhone section with the outdoor video wall. Springs use
Apple's SwiftUI defaults. When a film and this policy disagree, the policy wins.

## The rule

**Cut by default. Animate only when the motion carries the message.**

A motion earns its place only if it does one of three jobs:

1. **Demonstrates the claim.** The motion *is* the evidence: brightness numbers
   roll down while the frame dims, a slider moves, UI responds in a real recording.
2. **Explains a relationship.** A push into a screen means "inside this
   product". A pull-back means "part of something bigger". An exit push through
   a wall into the next scene means "this leads there".
3. **Points attention at one thing.** A hero number settles into focus so the
   eye lands on it before the voice says it.

Everything else, including type entrances, value changes, list updates and
chapter changes, is a cut.

## Measured vocabulary

| Motion | When | Spec (measured) |
| --- | --- | --- |
| **Cut** | Default between shots, cards, values, phrases | Hard cut, 0 frames. No dissolves, no lateral slides. |
| **Focus settle** | A hero stat or claim appears | 0.35 s: scale 1.6 → 1.0, blur 16 → 0 px, opacity 0.3 → 1, `Spring(duration: 0.35, bounce: 0)`. Then hold still ≥ 2 s. |
| **Replace value** | A stat changes on the same surface | Cut to empty for 0.2 s, then focus-settle the new value. Never count up. |
| **Numeric roll** | Only when the change is the point (a range, a before/after, a countdown) | 1.4 s. Per-digit odometer roll with vertical motion blur; values interpolate in log space when the range spans ≥ 10×; `Spring(duration: 1.4, bounce: 0)`. Pair it with a visible consequence (e.g. the field dims). |
| **Entrance settle** | Camera arriving on a device or UI | Ease-out `cubic-bezier(0.4, 0.3, 0.4, 0.9)`, 0.9–1.1 s, starts 0.2 s before the cut. |
| **Exit push** | Leaving a wall or screen into the next scene | Ease-in (accelerating) 1.2–1.8 s into blur; the next shot opens already moving. |
| **Hold** | After any settle | Camera and type still. The product (recording) is the only thing moving. |

## Prohibited
- Text sliding in from the side, word-by-word builds, typewriter effects.
- Counting a number up from zero to reveal it.
- Dissolves between shots, and slow "breathing" drift on holds.
- Two independent motions at once (camera plus type, or type plus type).
- Motion blur on anything the camera isn't moving.

## Springs (SwiftUI reference)
- `Animation.smooth` / `Spring(duration: 0.5, bounce: 0)` is SwiftUI's default
  no-bounce spring. With zero bounce it is critically damped:
  `x(t) = 1 − (1 + ωt)·e^(−ωt)`, with `ω = 2π / duration`.
- `ContentTransition.numericText(countsDown:)` is Apple's numeric content
  transition: digits change individually rather than the whole string
  cross-fading. Our numeric roll is the film-scale version of that idea.

## Sets
- A video wall is a **single, flat, bright wall in a real space**, framed wide
  and **locked off**. Its content is the same full-screen graphic, placed in
  the world. The edit cuts between the wide of the wall and the full-frame
  graphic, and leaves by pushing through the wall.
- Wall content follows every rule above: cut in, focus-settle for heroes,
  cut to blank before replacing a value.
