#!/usr/bin/env bash
#
# verify-edit.sh — Post-edit verification hook for Cursor and Claude Code.
#
# Runs tsc (type-checking) and eslint (linting) after file edits.
# Exits non-zero with error details if either check fails, which causes
# the IDE to surface the errors to the agent.
#
# Configuration: place a .recursive/verify.json in the project root to
# override defaults. Example:
#   {
#     "commands": [
#       { "name": "typecheck", "command": "npx tsc --noEmit" },
#       { "name": "lint", "command": "npx eslint . --quiet" }
#     ],
#     "timeout": 30,
#     "enabled": true
#   }

set -euo pipefail

PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$PROJECT_ROOT"

CONFIG_FILE="$PROJECT_ROOT/.recursive/verify.json"

# Default commands
COMMANDS=()
NAMES=()

if [[ -f "$CONFIG_FILE" ]]; then
  # Read commands from config using node (available in all Recursive projects)
  while IFS='|' read -r name cmd; do
    NAMES+=("$name")
    COMMANDS+=("$cmd")
  done < <(node -e "
    const c = require('$CONFIG_FILE');
    if (!c.enabled && c.enabled !== undefined) process.exit(0);
    for (const entry of c.commands || []) {
      console.log(entry.name + '|' + entry.command);
    }
  " 2>/dev/null)
fi

# Fall back to defaults if no config or empty commands
if [[ ${#COMMANDS[@]} -eq 0 ]]; then
  # Only run checks if the tools exist in the project
  if [[ -f "$PROJECT_ROOT/tsconfig.json" ]]; then
    NAMES+=("typecheck")
    COMMANDS+=("npx tsc --noEmit")
  fi
  if [[ -f "$PROJECT_ROOT/.eslintrc.json" ]] || [[ -f "$PROJECT_ROOT/.eslintrc.js" ]] || [[ -f "$PROJECT_ROOT/.eslintrc.cjs" ]] || [[ -f "$PROJECT_ROOT/eslint.config.js" ]] || [[ -f "$PROJECT_ROOT/eslint.config.mjs" ]] || [[ -f "$PROJECT_ROOT/eslint.config.ts" ]]; then
    NAMES+=("lint")
    COMMANDS+=("npx eslint . --quiet")
  fi
fi

if [[ ${#COMMANDS[@]} -eq 0 ]]; then
  exit 0
fi

ERRORS=""
FAILED=0

for i in "${!COMMANDS[@]}"; do
  name="${NAMES[$i]}"
  cmd="${COMMANDS[$i]}"
  
  output=$(eval "$cmd" 2>&1) || {
    FAILED=1
    ERRORS="${ERRORS}--- ${name} FAILED ---\n${output}\n\n"
  }
done

if [[ $FAILED -ne 0 ]]; then
  echo -e "Verification failed after file edit.\n\n${ERRORS}Fix these errors before proceeding." >&2
  exit 2
fi

exit 0
