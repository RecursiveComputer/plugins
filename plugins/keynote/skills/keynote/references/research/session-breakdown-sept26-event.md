# Breakdown: September 9, 2026 Apple Event (iPhone 18 Pro and more)

The full 77-minute event, sampled every 8 s (580 frames), plus the reference frames
from this event supplied for v9. The footage is studied locally and deleted after
study.

## One space per story, many angles of it

Each segment lives in **one continuous place**: the Apple Park office floors for
iPhone 18 Pro, a studio backlot for Camera, a single white stage for the finale.
Variety comes from **angles of the same space**: wides, mediums across desks,
views out the glass, the presenter walking between areas. The segment never jumps
between unrelated rooms. Location changes only at a new product.

## Overlays on the environment (instead of a video wall)

A frequent device here: big type or UI **composited over a real angle of the space**,
with a slow camera move. No wall is involved.

| Use | Example | Construction |
| --- | --- | --- |
| Section title | "Performance" over the office with a view; "Battery" over a lab bench | White display type, ~20% of frame height, centred, over a well-lit angle; slow push or drift |
| Chapter index | "Intelligence / Performance / Battery" over sky, the current one bright, the others dim | Stacked list; the active item at full white |
| Hero number | "50%" + "More noise reduction than AirPods 4" under an arched ceiling; "45 hours" on a tabletop | Huge number + one supporting line, over a calm, textured surface |
| Floating icons | App icons appearing in the air beside the presenter | Icons composited into the wide, one by one |
| Chart in the space | "Sustained performance" on a desktop display in the lab, then cut to it full frame | The same chart graphic is shown on a real screen in the space, then full screen |

## UI rendered huge, on flat black

UI is often shown **scaled up and razor sharp on pure black**: a Mail search with
highlighted matches, a heart-rate widget, a control pill. It isn't a screenshot on a
device. It's the component itself, re-rendered at large scale with its real content,
sometimes animating (typing, highlights appearing). Crispness is the point: the type
edges and glass highlights must survive a full-frame 4K master.

## Charts: build, or show final and move

Two modes, never mixed in one shot:
1. **Build**: bars grow to their values, the leader first, with the value labels
   appearing as each settles (no counting numbers).
2. **Final + move**: the chart is already complete; the camera does the work (a slow push,
   or a cut from the display in the space to full screen).

The "Sustained performance" chart: title top-left in large bold white; rows with the
product name in white and the chip name in grey; thin rounded bars; the leader bar
with a light gradient; comparative values right-aligned ("40% more", "2x more").

## Device grids

A wall of devices on black, each showing a different app screen (games, FaceTime,
Messages, Siri), as a flat grid that drifts slowly. The transition *into* it is a
fast zoom-out with motion blur from one device. It says "all of this" without words.

## Chip diagram

A flat line-art die map. Regions light up with a white outline and glow as they're
named, with a text column on the left ("6-core CPU / 2 new super cores / 20% faster").
Highlight = the thing being talked about; everything else stays dim.

## Music (measured)

Loudness every 2 s across the opening 170 s and the last 150 s, with caption word
timings marking speech:

| Moment | What plays | Level |
| --- | --- | --- |
| 0:00–2:05 cold open (a film) | Full score, the film's own music | −10 to −18 dB RMS, peaks −10 |
| Presenter segments | **No music**: dry voice | −17 to −26 dB (speech only) |
| Closing sizzle (~28 s before the final lines) | Music at full level, no voice | −15 to −19 dB |
| Final line → logo | Music enters *under the last sentence*, swells, ends hard on the logo, then silence | −17 to −21 dB, cut to −56 dB in 2 s |

Tempo: the opening film sits near 60–62 BPM, the closing sting near 87 BPM.

**Heuristic for our films**
1. Music exists in exactly two places: the **cold open** (under the opening montage,
   through to the first title) and the **outro** (entering under the last spoken
   sentence and ending on the final frame). Never under demos or explanations.
2. When it plays, it's the **foreground**: 8–10 dB louder than the dry voice's RMS,
   not a bed underneath.
3. The open **swells into the first title and stops on a hit** (a clean ending on
   the cut), not a fade under speech. The outro **ends hard on the logo**, then 1–2 s
   of silence.
4. Character: modern, confident, sparse. A slow, wide build (~60 BPM feel) for the
   open; a brighter, more rhythmic lift (~85–90 BPM) for the outro. No vocals.
5. Transitions inside the film get **no** music stingers or whooshes.

Generated music (ElevenLabs Music) needs an API key with the `music_generation`
permission. The current key has neither `music_generation` nor `sound_generation`.
