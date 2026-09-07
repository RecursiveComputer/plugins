---
description: "Type-check and lint after every batch of source edits."
alwaysApply: true
---

# Verify after edit

The installed hook runs local static checks after source edits. Follow the project's verification policy and reuse current hook results; do not run a second identical check just to satisfy this rule. Batch edits into coherent changes rather than verifying each keystroke.

The hook discovers the nearest package/module from manifests and lockfiles, prefers project scripts, and never installs dependencies. A versioned `.recursive/verify.json` can define explicit argv arrays, cwd, timeout, and environment; generate it with `VERIFY_AFTER_EDIT_MODE=write` only when a project-owned recipe is wanted. Existing recipes are not overwritten automatically.

A nearest AGENTS.md can override discovery with narrow directives:

```text
verify-after-edit: typecheck: npm run typecheck
verify-after-edit: lint: npm run lint
```

These are plain argv, not shell programs: quotes, redirects, substitutions, pipes, and other shell syntax are rejected.

In Recursive, use `npm run verify` and `docs/agent-development.md` for scoped checks. There is no root tsconfig; do not run bare root `tsc --noEmit` or a repository-wide ESLint fallback. Changes to verification configuration require its checks; ordinary prose does not require runtime setup.

Fix errors caused by the requested change. Diagnose other failures before labeling them pre-existing, report unresolved checks, and never weaken architecture contracts or pad baselines to obtain a pass.
