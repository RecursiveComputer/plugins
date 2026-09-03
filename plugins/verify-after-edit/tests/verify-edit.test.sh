#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -P -- "$(dirname -- "$0")" && pwd -P)"
HOOK="$SCRIPT_DIR/../hooks/verify-edit.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/verify-after-edit-test.XXXXXX")"
trap 'rm -rf -- "$TEST_ROOT"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local needle="$1" file="$2"
  grep -F -- "$needle" "$file" >/dev/null || fail "expected '$needle' in $file"
}

make_tool() {
  local name="$1"
  mkdir -p "$TEST_ROOT/bin"
  cat >"$TEST_ROOT/bin/$name" <<'SCRIPT'
#!/usr/bin/env bash
printf '%s\037' "$0" "$@" >>"${VERIFY_TEST_LOG:?}"
printf '\n' >>"${VERIFY_TEST_LOG:?}"
SCRIPT
  chmod +x "$TEST_ROOT/bin/$name"
}

make_tool pnpm
make_tool go
make_tool cargo
make_tool ruby
make_tool bundle
make_tool ruff

NODE_ROOT="$TEST_ROOT/node-workspace"
mkdir -p "$NODE_ROOT/packages/widget/src"
touch "$NODE_ROOT/pnpm-lock.yaml"
cat >"$NODE_ROOT/package.json" <<'JSON'
{"private":true,"packageManager":"pnpm@9.0.0","workspaces":["packages/*"]}
JSON
cat >"$NODE_ROOT/packages/widget/package.json" <<'JSON'
{"name":"widget","scripts":{"lint":"pnpm lint command","typecheck":"pnpm type command"}}
JSON
touch "$NODE_ROOT/packages/widget/src/index.ts"

PLAN="$TEST_ROOT/node-plan.txt"
PATH="$TEST_ROOT/bin:$PATH" VERIFY_AFTER_EDIT_PROJECT_ROOT="$NODE_ROOT" VERIFY_AFTER_EDIT_MODE=plan VERIFY_AFTER_EDIT_CHANGED_FILES='packages/widget/src/index.ts' "$HOOK" >"$PLAN"
assert_contains $'typecheck:packages/widget\tpackages/widget\t30\tpnpm\037run\037typecheck\tpackage.json scripts.typecheck' "$PLAN"
assert_contains $'lint:packages/widget\tpackages/widget\t30\tpnpm\037run\037lint\tpackage.json scripts.lint' "$PLAN"

VERIFY_AFTER_EDIT_PROJECT_ROOT="$NODE_ROOT" VERIFY_AFTER_EDIT_MODE=plan VERIFY_AFTER_EDIT_CHANGED_FILES='README.md' "$HOOK" >"$PLAN"
[[ ! -s "$PLAN" ]] || fail 'non-source changes should not plan verification'

cat >"$NODE_ROOT/packages/widget/AGENTS.md" <<'AGENTS'
verify-after-edit: typecheck: pnpm run guided-check
AGENTS
PATH="$TEST_ROOT/bin:$PATH" VERIFY_AFTER_EDIT_PROJECT_ROOT="$NODE_ROOT" VERIFY_AFTER_EDIT_MODE=plan VERIFY_AFTER_EDIT_CHANGED_FILES='packages/widget/src/index.ts' "$HOOK" >"$PLAN"
assert_contains $'typecheck:guidance\tpackages/widget\t30\tpnpm\037run\037guided-check\tAGENTS.md' "$PLAN"

MANIFEST_ROOT="$TEST_ROOT/manifest-project"
mkdir -p "$MANIFEST_ROOT/src" "$MANIFEST_ROOT/node_modules/.bin"
cat >"$MANIFEST_ROOT/package.json" <<'JSON'
{"name":"manifest-project","eslintConfig":{}}
JSON
touch "$MANIFEST_ROOT/tsconfig.json" "$MANIFEST_ROOT/.eslintrc.json" "$MANIFEST_ROOT/src/index.ts"
make_manifest_bin() {
  local name="$1"
  cat >"$MANIFEST_ROOT/node_modules/.bin/$name" <<'SCRIPT'
#!/usr/bin/env bash
exit 0
SCRIPT
  chmod +x "$MANIFEST_ROOT/node_modules/.bin/$name"
}
make_manifest_bin tsc
make_manifest_bin eslint
VERIFY_AFTER_EDIT_PROJECT_ROOT="$MANIFEST_ROOT" VERIFY_AFTER_EDIT_MODE=write VERIFY_AFTER_EDIT_CHANGED_FILES='src/index.ts' "$HOOK" >/dev/null
assert_contains '"version": 1' "$MANIFEST_ROOT/.recursive/verify.json"
assert_contains '"argv": ["' "$MANIFEST_ROOT/.recursive/verify.json"
assert_contains '"environment": {' "$MANIFEST_ROOT/.recursive/verify.json"
assert_contains '"detectedFrom": [' "$MANIFEST_ROOT/.recursive/verify.json"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$MANIFEST_ROOT/.recursive/verify.json"

CONFIG_ROOT="$TEST_ROOT/config-project"
mkdir -p "$CONFIG_ROOT/.recursive"
cat >"$CONFIG_ROOT/.recursive/verify.json" <<JSON
{
  "version": 1,
  "enabled": true,
  "environment": {"source": "test"},
  "recipes": [{"name": "literal-argv", "cwd": ".", "argv": ["$TEST_ROOT/bin/pnpm", "\$(touch $CONFIG_ROOT/owned)"], "timeout": 5}]
}
JSON
VERIFY_TEST_LOG="$TEST_ROOT/execution.log" VERIFY_AFTER_EDIT_PROJECT_ROOT="$CONFIG_ROOT" "$HOOK" >/dev/null
[[ ! -e "$CONFIG_ROOT/owned" ]] || fail 'config argv was evaluated by a shell'
assert_contains "\$(touch $CONFIG_ROOT/owned)" "$TEST_ROOT/execution.log"

cat >"$CONFIG_ROOT/.recursive/verify.json" <<'JSON'
{"version":1,"commands":[{"name":"unsafe","command":"touch should-not-run"}]}
JSON
if VERIFY_AFTER_EDIT_PROJECT_ROOT="$CONFIG_ROOT" "$HOOK" >/dev/null 2>&1; then
  fail 'legacy shell command configuration was accepted'
fi

GO_ROOT="$TEST_ROOT/go-project"
mkdir -p "$GO_ROOT/pkg"
touch "$GO_ROOT/go.mod" "$GO_ROOT/pkg/main.go"
PATH="$TEST_ROOT/bin:$PATH" VERIFY_AFTER_EDIT_PROJECT_ROOT="$GO_ROOT" VERIFY_AFTER_EDIT_MODE=plan VERIFY_AFTER_EDIT_CHANGED_FILES='pkg/main.go' "$HOOK" >"$PLAN"
assert_contains $'typecheck:.\t.\t30\tenv\037GOPROXY=off\037go\037vet\037./...\tgo.mod (offline)' "$PLAN"
assert_contains $'test:.\t.\t30\tenv\037GOPROXY=off\037go\037test\037./...\tgo.mod (offline)' "$PLAN"

RUST_ROOT="$TEST_ROOT/rust-project"
mkdir -p "$RUST_ROOT/src"
touch "$RUST_ROOT/Cargo.toml" "$RUST_ROOT/clippy.toml" "$RUST_ROOT/src/lib.rs"
PATH="$TEST_ROOT/bin:$PATH" VERIFY_AFTER_EDIT_PROJECT_ROOT="$RUST_ROOT" VERIFY_AFTER_EDIT_MODE=plan VERIFY_AFTER_EDIT_CHANGED_FILES='src/lib.rs' "$HOOK" >"$PLAN"
assert_contains $'typecheck:.\t.\t30\tcargo\037check\037--offline\tCargo.toml (offline)' "$PLAN"
assert_contains $'lint:.\t.\t30\tcargo\037clippy\037--offline\037--all-targets\037--\037-D\037warnings\tclippy configuration (offline)' "$PLAN"

PYTHON_ROOT="$TEST_ROOT/python-project"
mkdir -p "$PYTHON_ROOT/src"
cat >"$PYTHON_ROOT/pyproject.toml" <<'TOML'
[tool.ruff]
TOML
touch "$PYTHON_ROOT/src/app.py"
PATH="$TEST_ROOT/bin:$PATH" VERIFY_AFTER_EDIT_PROJECT_ROOT="$PYTHON_ROOT" VERIFY_AFTER_EDIT_MODE=plan VERIFY_AFTER_EDIT_CHANGED_FILES='src/app.py' "$HOOK" >"$PLAN"
assert_contains $'lint:.\t.\t30\t' "$PLAN"
assert_contains $'lint:.\t.\t30\t'"$TEST_ROOT"$'/bin/ruff\037check\037src/app.py\tPython ruff configuration' "$PLAN"

RUBY_ROOT="$TEST_ROOT/ruby-project"
mkdir -p "$RUBY_ROOT/lib"
touch "$RUBY_ROOT/Gemfile" "$RUBY_ROOT/.rubocop.yml" "$RUBY_ROOT/lib/app.rb"
PATH="$TEST_ROOT/bin:$PATH" VERIFY_AFTER_EDIT_PROJECT_ROOT="$RUBY_ROOT" VERIFY_AFTER_EDIT_MODE=plan VERIFY_AFTER_EDIT_CHANGED_FILES='lib/app.rb' "$HOOK" >"$PLAN"
assert_contains $'typecheck:.\t.\t30\truby\037-c\037lib/app.rb\tRuby source' "$PLAN"
assert_contains $'lint:.\t.\t30\tbundle\037exec\037rubocop\037lib/app.rb\trubocop configuration' "$PLAN"

printf 'verify-after-edit tests passed\n'
