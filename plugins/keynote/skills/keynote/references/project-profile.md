# Project profile (`KEYNOTE.md`)

Each project that makes films keeps one `KEYNOTE.md` (root, `docs/`, or its keynotes folder).
`/keynote` reads it first; if it is missing, write it with the user from this template. Keep
it factual and current: the next film starts from it.

```markdown
# Keynote profile: <Product>

## Brand
- Display font: <family> — <absolute paths to the licensed woff2 files and weights>
- Body font: <family>
- App icon: <path to a square PNG, ≥ 512 px>
- Brand backdrop: <how to record it, e.g. a WebGL hero field: command + aspect>, or "none"
- Colours: accent <hex>; product glyph source: <icon sprite / SVG folder>

## Voice and music
- Voice: ElevenLabs <voice id>, eleven_v4
- Music: ElevenLabs Music v2.5; keys from <env / .env>

## Product capture (never live user data)
- Open: <how to reach a seeded demo or fixture build; URL; the open() hook file>
- Flows: <file exporting the recorder flows> — names and what each proves
- Components worth capturing: <real UI pieces and how to reach their states>

## Set
- Location: <folder with floorplan, angles, aerial, pinned motion clips, bookends>
- Hero wide: <file>; LED wall content stills: <files>
- Angles: <name → file → what it's for>

## Films
- <version>: <published path>, validation <score>, notes
```
