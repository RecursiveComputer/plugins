---
description: "Type-check and lint after every batch of source edits."
alwaysApply: true
---

# Verify After Edit

After modifying `.ts`, `.tsx`, `.js`, `.jsx`, `.svelte`, or `.css`, run verification once per batch — not per keystroke — before claiming the work is done:

1. `npx tsc --noEmit`
2. `npx eslint . --quiet`

Fix all errors in files you modified. Pre-existing failures in untouched files: note in your response, don't block on them. Skip both commands for `.md` / `.json` / `.yaml` changes, or if the project doesn't depend on TypeScript / ESLint.
