---
description: "Type-check and lint after every batch of source edits."
alwaysApply: true
---

# Verify After Edit

After modifying `.ts`, `.tsx`, `.js`, `.jsx`, `.svelte`, `.css`, `.py`, `.go`, `.rs`, or `.rb`, run verification once per batch — not per keystroke — before claiming the work is done. Skip checks for `.md` / `.json` / `.yaml` changes unless they change a project-specific verification configuration.

The installed hook discovers a nearest package/module from its manifest and lockfile, then runs only local scripts, executables, or language tooling already present. It never uses `npx`, `pip install`, `bundle install`, or any other dependency installation command. In a Node monorepo, it uses the nearest package manifest and the nearest `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, or Bun lockfile; package scripts are preferred over fallback tools.

For a project-owned, reviewable recipe file, generate it once with `VERIFY_AFTER_EDIT_MODE=write` (or `VERIFY_AFTER_EDIT_WRITE_MANIFEST=1`). The resulting `.recursive/verify.json` is versioned (`version: 1`) and contains explicit `argv` arrays, `cwd`, `timeout`, source metadata, and an `environment` section. It is never overwritten automatically. Do not use shell command strings: argv arrays are executed directly, without `eval` or shell interpolation.

The nearest `AGENTS.md` can override an automatically discovered check with a deliberately narrow directive:

```text
verify-after-edit: typecheck: npm run typecheck
verify-after-edit: lint: npm run lint
```

Each directive is tokenized as plain argv and rejects quotes, redirects, substitutions, pipes, and other shell syntax.

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
