# Film format (keynote engine)

A film is JSON (`format: "keynote"`) of acts and shots, rendered frame by frame by the keynote
engine (`scripts/render.sh`). The authoritative types are the engine's `src/keynote/film.ts`;
this page is the working subset the runbook uses. Lint with `render.sh FILM.json --lint`.

## Top level

```json
{
  "format": "keynote", "title": "Product v2",
  "canvas": { "width": 1920, "height": 1080, "fps": 30 },
  "theme": { "font": "Inter, sans-serif", "display": "'Brand Display', Inter, sans-serif",
             "fonts": [{ "family": "Brand Display", "src": "/abs/path/display-bold.woff2", "weight": 700 }] },
  "voice": { "voiceId": "<ElevenLabs voice id>", "modelId": "eleven_v4" },
  "music": { "cues": [{ "src": "/abs/open.mp3", "at": "start", "gainDb": -3 },
                      { "src": "/abs/outro.mp3", "at": "end", "gainDb": -3, "endPad": 0.2 }], "duckDb": 12 },
  "acts": [ … ]
}
```

## Acts and the script

```json
{ "id": "context", "kind": "chapter", "scriptAt": 0.6, "scriptTail": 1.4,
  "script": "Let's start with what your agent knows. {cx} Right above the composer… {cx.1} Open it, and…",
  "shots": [ … ] }
```

- `script` is one voice take. Cues: `{id}` cuts to shot `id` on the next word; `{id.label}`
  shows its label/line on that word; `{id.N}` brings in item N of a motion shot (the shot gets
  `itemAt`); `{id@anchor}` makes a `demo` recording reach `action:N`, `arrive:N` or `aha` on
  that word.
- `scriptAt`: seconds into the act before the voice (open act: after the drone lands and the
  wall powers on). `scriptTail`: seconds held after the last word (close act: the whole drone
  out).
- A first shot started by a cue leaves the act's opening words over the previous shot's end or
  nothing: start the act's first shot with the act (no cue) unless that's intended.
- After a render, `film.plan.json` lists every shot's `start`, `duration`, `labelAt`, `itemAt`.

## Shots used by the runbook

| type | Fields | Use |
| --- | --- | --- |
| `clip` | `src`, `from`, `to`, `label` (string or lines), `labelSide: center\|left\|right`, `flight` | Environment angles with section titles; drone bookends (`flight: true` exempts the locked-camera gate); reframed UI recordings |
| `demo` | `src` (recording with `.timing.json`/`.positions.json`), `camera`, `from`, `to` | A live UI recording with the virtual camera and drawn cursor |
| `words` | `phrases`, `tone`, `backdrop` | A reinforcing line (different words from the voice) |
| `motion` | `template` + fields below | Motion graphics |
| `title`, `stat`, `lift`, `wall`, `stage`, `endcard`, `recap` | see `film.ts` | Older grammar; the runbook rarely needs them |

### Motion templates

| template | Fields | Idea |
| --- | --- | --- |
| `pick` | `items: [{src, sel?}]` (3x row captures), `pick`, `rowRadius`, `header: {src, color, x?}`, `detail: [{src, x?}]`, `step` (text rows naming choices) | Several → choose one ({id.1}) → what it did ({id.2}). With `header.x`/`detail[].x` the pieces keep the product's left alignment; `sel` crossfades the row's real selected state; `header.color` = the selected row's colour (the morph shape) |
| `triptych` | `items: [{label, icon (SVG), color}]` | Three choices as large glyphs; the focus moves on {id.1..3} |
| `category` | `title`, `subtitle`, `items: [{label}\|{label, src}]`, `bleed` | A hero number with names or logo tiles around it, most recognizable nearest; `bleed` runs big tiles past every edge while the camera pulls back once |
| `bars` | `title`, `mode: build\|final`, `items: [{label, value, display}]` | A chart: build once, or final with the camera doing the work |
| `bento` | `areas` (CSS grid rows), `items: [{area, kind, label, sub, display, list, icon, img, video, color, color2}]` | Apple bento. `kind`: `hero` (brand: `video` plate + `img` app icon), `icon`, `chips`, `marquee`, `text` (auto-fit gradient word), `diff`, `search`, `ui` |
| `stack` | `items`, `tone`, `ui: {src, target}`, `handoffAt` | Parts become one real UI element (only when the landing is exact) |

Assets are absolute paths. UI pieces are 3x captures shown at 2x (`SC = 2/3`).
