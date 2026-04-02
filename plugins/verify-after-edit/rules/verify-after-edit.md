---
description: "Agents must run type-checking and linting after every file modification and fix all errors before proceeding."
alwaysApply: true
---

# Verify After Edit

After modifying any source file (`.ts`, `.tsx`, `.js`, `.jsx`, `.svelte`, `.css`), you MUST run verification before reporting results or moving to the next task:

1. **Type-check**: `npx tsc --noEmit` — fix all type errors before proceeding
2. **Lint**: `npx eslint . --quiet` — fix all lint errors before proceeding

If either command exits non-zero, fix the issues and re-run until both pass. Do NOT tell the user changes are complete until verification succeeds.

This applies after every batch of file edits — not after each individual keystroke, but before you consider any unit of work "done." If you edited 5 files to implement a feature, verify once after all 5 edits.

## When to Skip

- **Non-source files**: Changes to `.md`, `.json`, `.yaml`, images, or config files do not require verification
- **Explicit user override**: If the user says "skip verification" or "don't lint", respect that for the current task only
- **No TypeScript/ESLint in project**: If the project does not have `typescript` or `eslint` as dependencies, skip the corresponding check

## Error Handling

If verification reveals errors you did not introduce (pre-existing failures), note them in your response but do not block on them. Only block on errors in files you modified.
