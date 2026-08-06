---
description: "Type-check and lint after every batch of source edits."
alwaysApply: true
---

# Verify After Edit

After modifying `.ts`, `.tsx`, `.js`, `.jsx`, `.svelte`, or `.css`, run verification once per batch — not per keystroke — before claiming the work is done. Skip both checks for `.md` / `.json` / `.yaml` changes, or if the project doesn't depend on TypeScript / ESLint.

## Monorepo: scope verification to the packages you touched

This repo has **no root `tsconfig.json`** and root ESLint catches pre-existing errors across all workspaces. Never run bare `npx tsc --noEmit` or `npx eslint . --quiet` from the repo root.

### Type-check

Determine which workspace(s) your edits fall in and run the closest scoped check:

| Edited path prefix | Command |
| --- | --- |
| `apps/recursive/` | `npm run -w @recursive/app-recursive typecheck` |
| `apps/financial/` | `npm run -w @recursive/app-financial typecheck` |
| `apps/recursive-ios/` | `npm run -w @recursive/app-recursive-ios typecheck` |
| `packages/<name>/` | `npx tsc --noEmit -p packages/<name>/tsconfig.json` |
| `plugins/` | `npx tsc --noEmit -p packages/core-server/tsconfig.json` (plugins are consumed by core-server) |
| `websites/` | `npx tsc --noEmit -p websites/<name>/tsconfig.json` |

If you touched files in multiple workspaces, run the check for each.

### Lint

Scope ESLint to the directories you touched instead of the whole repo:

```
npx eslint packages/core-shell/src/ packages/core-server/src/ --quiet
```

Adjust the paths to match the actual directories you edited.

### Architecture checks

If the batch touched `packages/`, `apps/`, or `plugins/` source, also run:

```
npm run test:arch
```

It is fast (~1s) and enforces the subsystem contracts in `docs/architecture/contracts/`:
package layering, the permissions guard, and the sync-spine write seam. A failure names
the contract it violated and the refactor that would retire the rule.

Never make it pass by widening a rule or by hand-adding to a baseline in
`tests/architecture/baselines/` — those may shrink, never grow. If you changed an
invariant on purpose, change the contract in the same commit.

When editing the checks themselves, run `npm run typecheck:arch`.

## Error handling

Fix all errors in files you modified. Pre-existing failures in untouched files: note in your response, don't block on them.
