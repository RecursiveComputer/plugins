#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -P -- "$(dirname -- "$0")" && pwd -P)"
HOOK="$SCRIPT_DIR/../hooks/before-after.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/before-after-test.XXXXXX")"
trap 'rm -rf -- "$TEST_ROOT"' EXIT

export RECURSIVE_HOME="$TEST_ROOT/home"
export RECURSIVE_SESSION_ID="s_test"
STATE="$RECURSIVE_HOME/run/before-after/s_test.json"
mkdir -p "$TEST_ROOT/src"
touch "$TEST_ROOT/src/Card.svelte" "$TEST_ROOT/src/util.ts" "$TEST_ROOT/src/Card.test.tsx"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pre() { printf '{"tool_name":"Edit","tool_input":{"file_path":"%s","old_string":"a"}}' "$1" | "$HOOK" pre; }
stop() { printf '{"stop_hook_active":%s}' "${1:-false}" | "$HOOK" stop; }

# Non-UI, test, and brand-new files pass silently.
[ -z "$(pre "$TEST_ROOT/src/util.ts")" ] || fail "non-UI file was held"
[ -z "$(pre "$TEST_ROOT/src/Card.test.tsx")" ] || fail "test file was held"
[ -z "$(pre "$TEST_ROOT/src/New.svelte")" ] || fail "new file was held"

# First UI edit of a turn is held once, then allowed.
out="$(pre "$TEST_ROOT/src/Card.svelte")"
printf '%s' "$out" | grep -q '"permissionDecision":"deny"' || fail "first UI edit was not held"
printf '%s' "$out" | python3 -c 'import json,sys; json.load(sys.stdin)' || fail "deny output is not JSON"
[ -z "$(pre "$TEST_ROOT/src/Card.svelte")" ] || fail "second UI edit was held"

# A new prompt resets the cycle.
printf '{}' | "$HOOK" prompt
[ ! -f "$STATE" ] || fail "prompt did not reset state"
[ -n "$(pre "$TEST_ROOT/src/Card.svelte")" ] || fail "new turn did not hold again"

# Captured/skipped state lets edits through.
printf '{"status":"before","url":"http://x","beforePath":"/tmp/b.png","at":"t"}' >"$STATE"
[ -z "$(pre "$TEST_ROOT/src/Card.svelte")" ] || fail "edit held after before capture"

# Stop reminds exactly once while a before capture is pending, keeping the capture.
out="$(stop)"
printf '%s' "$out" | grep -q '"decision":"block"' || fail "stop did not remind"
printf '%s' "$out" | python3 -c 'import json,sys; json.load(sys.stdin)' || fail "stop output is not JSON"
grep -q '"beforePath":"/tmp/b.png"' "$STATE" || fail "stop dropped the capture"
[ -z "$(stop)" ] || fail "stop reminded twice"
printf '{"status":"before","at":"t"}' >"$STATE"
[ -z "$(stop true)" ] || fail "stop ignored stop_hook_active"

printf '{"status":"done","at":"t"}' >"$STATE"
[ -z "$(stop)" ] || fail "stop reminded after publish"

# Outside Recursive, or switched off, the hook is inert.
rm -f "$STATE"
[ -z "$(RECURSIVE_SESSION_ID= pre "$TEST_ROOT/src/Card.svelte")" ] || fail "held without a session"
[ -z "$(RECURSIVE_BEFORE_AFTER=off pre "$TEST_ROOT/src/Card.svelte")" ] || fail "held while off"

printf 'before-after hook: ok\n'
