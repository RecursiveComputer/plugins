#!/usr/bin/env bash
# Before/after gate for UI edits. Modes: prompt (UserPromptSubmit), pre (PreToolUse), stop (Stop).
# Deterministic and model-free: the classifier is the edited file's extension.
# State is shared with the browser_before_after tool via $RECURSIVE_HOME/run/before-after/<session>.json.

set -u
mode="${1:-}"
sid="${RECURSIVE_SESSION_ID:-}"
[ -n "$sid" ] || exit 0
[ "${RECURSIVE_BEFORE_AFTER:-on}" = "off" ] && exit 0

state_dir="${RECURSIVE_HOME:-$HOME/.recursive}/run/before-after"
state_file="$state_dir/$(printf '%s' "$sid" | tr -c 'a-zA-Z0-9_-' '_').json"
input="$(cat 2>/dev/null || true)"

status() {
  [ -f "$state_file" ] || return 0
  sed -n 's/.*"status":"\([a-z]*\)".*/\1/p' "$state_file" | head -n 1
}

write_status() {
  mkdir -p "$state_dir" 2>/dev/null || return 0
  printf '{"status":"%s","at":"%s"}' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$state_file" 2>/dev/null || true
}

is_ui_file() {
  case "$1" in
    */node_modules/*|*/dist/*|*/build/*|*/tests/*|*/test/*|*/__tests__/*|*.test.*|*.spec.*|*.stories.*) return 1 ;;
    *.svelte|*.vue|*.tsx|*.jsx|*.astro|*.css|*.scss|*.sass|*.less|*.html) return 0 ;;
  esac
  return 1
}

case "$mode" in
  prompt)
    # A new user turn starts a fresh comparison cycle.
    rm -f "$state_file" 2>/dev/null
    ;;
  pre)
    file="$(printf '%s' "$input" | grep -o '"\(file_path\|notebook_path\)"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/')"
    [ -n "$file" ] || exit 0
    is_ui_file "$file" || exit 0
    [ -f "$file" ] || exit 0 # a brand-new file has no "before"
    [ -z "$(status)" ] || exit 0 # already captured, skipped, reminded, or done this turn
    write_status reminded
    reason='UI edit detected; this edit was NOT applied. First call browser_before_after({phase:"before", url, selector?, hover?, label}) for the view this change affects, then retry the edit. If the UI cannot be reached or nothing visible changes, call browser_before_after({phase:"skip", reason}) instead. Only this first UI edit of the turn is held.'
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$(printf '%s' "$reason" | sed 's/"/\\"/g')"
    ;;
  stop)
    printf '%s' "$input" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true' && exit 0
    [ "$(status)" = "before" ] || exit 0
    grep -q '"stop_reminded":true' "$state_file" 2>/dev/null && exit 0
    # Keep the stored capture; mark it so the reminder fires once.
    sed 's/"status":"before"/"status":"before","stop_reminded":true/' "$state_file" >"$state_file.tmp" 2>/dev/null && mv "$state_file.tmp" "$state_file"
    printf '%s\n' '{"decision":"block","reason":"A before capture is pending. Call browser_before_after({phase:\"after\"}) to embed the comparison, then finish."}'
    ;;
esac
exit 0
