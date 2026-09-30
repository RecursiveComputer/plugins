# Keynote quality rubric

Every film render is validated against this rubric before it ships. The automated
checks run with `scripts/validate-film.py <film.json> <render-dir>`;
the review checks are scored by a person (or agent) watching the render and the contact
sheet, and recorded in `validation.json` next to the render.

A film passes only when every **gate** passes. **Scored** items are 0–2 each; the film needs
at least 80% of the scored points and no 0 on any item marked ★.

## Automated gates

| # | Gate | Threshold |
| --- | --- | --- |
| A1 | No legacy footage | No source under `public/videos/demos`, no `release-*` recordings, no screen captures with dev data |
| A2 | Delivery format | 1920×1080 (or higher), 30 fps, H.264 + AAC |
| A3 | Loudness | Integrated −16 ± 1 LUFS, true peak ≤ −1 dBTP |
| A4 | Music only at the bookends | The music bed is silent (< −60 dB) between the end of the open cue and the start of the outro cue |
| A5 | Plates are steady | Every environment shot: frame-to-frame motion on static structure after the camera locks < 0.15 px RMS (drone flights, marked `flight`, are exempt) |
| A6 | Camera locks | No camera motion after the settle time (same measurement) |
| A7 | Overlays from frame one | Every centre overlay's `labelAt` ≤ 0.15 s |
| A8 | Shot lengths | No shot shorter than 1.0 s or longer than 14 s |
| A9 | Text guard | No clipped or off-frame text (the renderer fails the render otherwise) |
| A10 | Voice | Eleven v4 (`eleven_v4`), one take per chapter |
| A11 | No empty frames | No run of 0.5 s or more where the frame is flat (all black, or one flat colour with nothing on it) |

## Review (scored 0–2)

| # | Item | 2 = |
| --- | --- | --- |
| R1 ★ | Close the loop | Every motion graphic and demo ends on the answer, shown in real UI |
| R2 ★ | One space | One location; every environment shot is a planned angle of it; the LED wall only in its framing |
| R3 | Things people know | Recognizable items (logos, names) where the script names them, most familiar nearest the focus |
| R4 | Motion expresses the idea | Each phase of motion maps to a beat of the idea; no decorative motion |
| R5 | Symmetry | Grids and layouts are symmetric and fully filled |
| R6 | Word sync | Cuts, labels and items land on their words (not early, not late) |
| R7 | UI sharpness | UI renders are 3× captures shown ≤ 2×; no soft or scaled-up screenshots |
| R8 | Script flow | Chapters read as one continuous take; on-screen lines reinforce with different words |
| R9 | Typography | Lapidar for display; consistent sizes; nothing crowded |
| R10 | Environment realism | No artifacts (edge rims, invented objects, flicker); motion subtle and natural |
| R11 ★ | Purpose | Every shot drives the story: no empty cutaways of the space. Environment shots carry a section title, the wall, or a drone move into/out of the space; music plays only over those drone moves, before and after the voice |
| R12 ★ | Seamless UI | Every UI beat is the real UI performing (a recording or a morph that lands exactly on the real element); nothing appears or vanishes without a cause |
