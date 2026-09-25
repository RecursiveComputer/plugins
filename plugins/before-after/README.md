# Before / After

UI changes come back with a side-by-side before/after image embedded in the chat, without being asked.

- **Tool** — `browser_before_after` (core browser tool). `phase: "before"` captures the page (optionally cropped to `selector`, after hovering `hover`); `phase: "after"` re-captures the same view and records one composite PNG as a session artifact, which the chat renders inline. `phase: "skip"` records why no comparison applies.
- **Rule** — tells every provider to call it around visible UI edits.
- **Hooks** (Claude Code format) — a model-free classifier on the edited file's extension (`.svelte`, `.vue`, `.tsx`, `.jsx`, `.astro`, `.css`, `.scss`, `.sass`, `.less`, `.html`; tests, stories and build output excluded). The first UI edit of a turn with no capture is held once with instructions; a turn that ends with a pending before capture is reminded once to publish the after. `UserPromptSubmit` resets the cycle per turn.

State lives in `$RECURSIVE_HOME/run/before-after/<session>.json`, shared by the tool and the hooks. Set `RECURSIVE_BEFORE_AFTER=off` in a provider environment, or disable this plugin, to turn it off. Providers without Claude-format hooks follow the rule only.

Test: `bash tests/before-after.test.sh`.
