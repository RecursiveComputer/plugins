# Verify After Edit

The hook plans package-scoped verification after source edits without installing dependencies. It recognizes Node packages (npm, pnpm, Yarn, and Bun), Python project configuration, `go.mod`, `Cargo.toml`, and Ruby `Gemfile`/gemspec projects. A Node package script is preferred; otherwise it only uses a tool that is already available locally or on `PATH`.

## Reviewable manifest

Run the hook with `VERIFY_AFTER_EDIT_MODE=write` to create `.recursive/verify.json` from the current discovery result. The file is never overwritten and is safe to commit and review. Its only executable form is a direct argv array:

```json
{
  "version": 1,
  "enabled": true,
  "environment": {
    "source": "auto-discovery",
    "projectRoot": ".",
    "detectedFrom": ["packages/example/package.json", "pnpm-lock.yaml"]
  },
  "recipes": [
    {
      "name": "typecheck:packages/example",
      "cwd": "packages/example",
      "argv": ["pnpm", "run", "typecheck"],
      "timeout": 30,
      "source": "package.json scripts.typecheck"
    }
  ]
}
```

`version` must be `1`. `enabled: false` turns the hook off. `environment.detectedFrom` records the manifests and lockfiles used for discovery. Every `cwd` must stay inside the project, every timeout is 1–600 seconds, and argv values cannot contain control separators. Legacy `commands` and recipe-level `command` strings are rejected rather than evaluated. Go recipes set `GOPROXY=off` and Cargo recipes use `--offline`, so their verification cannot fetch dependencies.

## Scoped discovery

Pass newline-delimited edited paths in `VERIFY_AFTER_EDIT_CHANGED_FILES` when invoking the hook outside an IDE. The planning mode is deterministic and does not execute recipes:

```bash
VERIFY_AFTER_EDIT_MODE=plan VERIFY_AFTER_EDIT_CHANGED_FILES='packages/example/src/index.ts' \
  hooks/verify-edit.sh
```

The hook consumes Claude/Cursor file-path hook input when available. Fallback ESLint, Python, and Ruby checks receive only edited language files; package scripts and module checks run in their nearest package/module directory.

## `AGENTS.md` overrides

The nearest `AGENTS.md` may provide one direct-argv override per check:

```text
verify-after-edit: typecheck: npm run typecheck
verify-after-edit: lint: npm run lint
```

Directives are intentionally a no-shell grammar: quote characters, redirects, substitutions, pipes, and other shell operators are rejected.
