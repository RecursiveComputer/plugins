#!/usr/bin/env bash
#
# verify-edit.sh — safe, package-aware post-edit verification.

set -eo pipefail

DEFAULT_TIMEOUT="${VERIFY_AFTER_EDIT_TIMEOUT:-30}"
MODE="${VERIFY_AFTER_EDIT_MODE:-run}"
WRITE_MANIFEST="${VERIFY_AFTER_EDIT_WRITE_MANIFEST:-0}"
FIELD_SEPARATOR=$'\037'

if [[ -n "${VERIFY_AFTER_EDIT_PROJECT_ROOT:-}" ]]; then
  PROJECT_ROOT="$VERIFY_AFTER_EDIT_PROJECT_ROOT"
elif [[ -n "${CLAUDE_PROJECT_DIR:-}" ]]; then
  PROJECT_ROOT="$CLAUDE_PROJECT_DIR"
else
  PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi

PROJECT_ROOT="$(cd -P -- "$PROJECT_ROOT" && pwd -P)"
CONFIG_FILE="$PROJECT_ROOT/.recursive/verify.json"

declare -a RECIPE_NAMES=()
declare -a RECIPE_CWDS=()
declare -a RECIPE_TIMEOUTS=()
declare -a RECIPE_ARGVS=()
declare -a RECIPE_SOURCES=()
declare -a TARGET_DIRS=()
declare -a CHANGED_FILES=()
declare -a ENVIRONMENT_MARKERS=()
CHANGED_PATHS_PROVIDED=0

die() {
  printf 'verify-after-edit: %s\n' "$*" >&2
  exit 2
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

is_timeout() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]] && (( "$1" <= 600 ))
}

is_safe_field() {
  [[ "$1" != *$'\n'* && "$1" != *$'\r'* && "$1" != *$'\t'* && "$1" != *"$FIELD_SEPARATOR"* ]]
}

is_under_root() {
  local path="$1"
  [[ "$path" == "$PROJECT_ROOT" || "$path" == "$PROJECT_ROOT"/* ]]
}

normalise_cwd() {
  local cwd="$1"
  if [[ "$cwd" != /* ]]; then
    cwd="$PROJECT_ROOT/$cwd"
  fi
  cwd="$(cd -P -- "$cwd" 2>/dev/null && pwd -P)" || return 1
  is_under_root "$cwd" || return 1
  printf '%s' "$cwd"
}

add_recipe() {
  local name="$1"
  local cwd="$2"
  local timeout="$3"
  local source="$4"
  shift 4
  local normalised_cwd arg joined="" index=0

  [[ "$name" =~ ^[A-Za-z0-9._:/-]+$ ]] || die "recipe names may contain only letters, numbers, ., _, :, /, and -"
  is_timeout "$timeout" || die "recipe '$name' has an invalid timeout (use 1-600 seconds)"
  normalised_cwd="$(normalise_cwd "$cwd")" || die "recipe '$name' has a cwd outside the project"
  [[ $# -gt 0 ]] || die "recipe '$name' needs a non-empty argv array"

  for arg in "$@"; do
    is_safe_field "$arg" || die "recipe '$name' contains an unsupported control character"
    if (( index > 0 )); then
      joined+="$FIELD_SEPARATOR"
    fi
    joined+="$arg"
    ((index += 1))
  done

  RECIPE_NAMES+=("$name")
  RECIPE_CWDS+=("$normalised_cwd")
  RECIPE_TIMEOUTS+=("$timeout")
  RECIPE_ARGVS+=("$joined")
  RECIPE_SOURCES+=("$source")
}

has_recipe_named() {
  local wanted="$1" name
  for name in "${RECIPE_NAMES[@]}"; do
    [[ "$name" == "$wanted" ]] && return 0
  done
  return 1
}

record_environment_marker() {
  local marker="$1" existing
  for existing in "${ENVIRONMENT_MARKERS[@]}"; do
    [[ "$existing" == "$marker" ]] && return 0
  done
  ENVIRONMENT_MARKERS+=("$marker")
}

json_runtime() {
  if command -v node >/dev/null 2>&1; then
    printf 'node'
  elif command -v python3 >/dev/null 2>&1; then
    printf 'python3'
  elif command -v ruby >/dev/null 2>&1; then
    printf 'ruby'
  else
    return 1
  fi
}

parse_verify_config() {
  local runtime
  runtime="$(json_runtime)" || die "cannot read $CONFIG_FILE because node, python3, and ruby are unavailable"

  case "$runtime" in
    node)
      VERIFY_CONFIG_FILE="$CONFIG_FILE" node <<'NODE'
const fs = require('fs');
const file = process.env.VERIFY_CONFIG_FILE;
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
const field = (value, label) => {
  if (typeof value !== 'string' || /[\t\r\n\u001f]/.test(value)) throw new Error(`${label} must be a string without control separators`);
  return value;
};
if (!config || typeof config !== 'object' || Array.isArray(config) || config.version !== 1) throw new Error('verify.json must have version: 1');
if ('commands' in config) throw new Error('legacy commands are unsupported; use recipes with argv arrays');
if (config.enabled !== undefined && typeof config.enabled !== 'boolean') throw new Error('enabled must be a boolean');
if (config.environment !== undefined && (!config.environment || typeof config.environment !== 'object' || Array.isArray(config.environment))) throw new Error('environment must be an object');
if (config.recipes !== undefined && !Array.isArray(config.recipes)) throw new Error('recipes must be an array');
console.log(['V', config.enabled !== false ? '1' : '0'].join('\t'));
for (const recipe of config.recipes || []) {
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) throw new Error('each recipe must be an object');
  if ('command' in recipe) throw new Error('recipe.command is unsupported; use recipe.argv');
  const name = field(recipe.name, 'recipe.name');
  const cwd = field(recipe.cwd === undefined ? '.' : recipe.cwd, 'recipe.cwd');
  const timeout = recipe.timeout === undefined ? 30 : recipe.timeout;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600) throw new Error(`recipe ${name} has an invalid timeout`);
  if (!Array.isArray(recipe.argv) || recipe.argv.length === 0) throw new Error(`recipe ${name} must use a non-empty argv array`);
  const argv = recipe.argv.map((arg) => field(arg, `recipe ${name} argv`));
  console.log(['R', name, cwd, String(timeout), argv.join('\u001f'), recipe.source === undefined ? 'verify.json' : field(recipe.source, 'recipe.source')].join('\t'));
}
NODE
      ;;
    python3)
      VERIFY_CONFIG_FILE="$CONFIG_FILE" python3 - <<'PYTHON'
import json
import os

with open(os.environ['VERIFY_CONFIG_FILE'], encoding='utf-8') as handle:
    config = json.load(handle)

def field(value, label):
    if not isinstance(value, str) or any(character in value for character in ('\t', '\r', '\n', '\x1f')):
        raise ValueError(f'{label} must be a string without control separators')
    return value

if not isinstance(config, dict) or config.get('version') != 1:
    raise ValueError('verify.json must have version: 1')
if 'commands' in config:
    raise ValueError('legacy commands are unsupported; use recipes with argv arrays')
if 'enabled' in config and not isinstance(config['enabled'], bool):
    raise ValueError('enabled must be a boolean')
if 'environment' in config and not isinstance(config['environment'], dict):
    raise ValueError('environment must be an object')
recipes = config.get('recipes', [])
if not isinstance(recipes, list):
    raise ValueError('recipes must be an array')
print('V\t' + ('1' if config.get('enabled', True) else '0'))
for recipe in recipes:
    if not isinstance(recipe, dict):
        raise ValueError('each recipe must be an object')
    if 'command' in recipe:
        raise ValueError('recipe.command is unsupported; use recipe.argv')
    name = field(recipe.get('name'), 'recipe.name')
    cwd = field(recipe.get('cwd', '.'), 'recipe.cwd')
    timeout = recipe.get('timeout', 30)
    if not isinstance(timeout, int) or isinstance(timeout, bool) or not 1 <= timeout <= 600:
        raise ValueError(f'recipe {name} has an invalid timeout')
    argv = recipe.get('argv')
    if not isinstance(argv, list) or not argv:
        raise ValueError(f'recipe {name} must use a non-empty argv array')
    argv = [field(arg, f'recipe {name} argv') for arg in argv]
    source = field(recipe.get('source', 'verify.json'), 'recipe.source')
    print('\t'.join(('R', name, cwd, str(timeout), '\x1f'.join(argv), source)))
PYTHON
      ;;
    ruby)
      VERIFY_CONFIG_FILE="$CONFIG_FILE" ruby <<'RUBY'
require 'json'

config = JSON.parse(File.read(ENV.fetch('VERIFY_CONFIG_FILE')))
def field(value, label)
  raise "#{label} must be a string without control separators" unless value.is_a?(String) && value !~ /[\t\r\n\x1f]/
  value
end
raise 'verify.json must have version: 1' unless config.is_a?(Hash) && config['version'] == 1
raise 'legacy commands are unsupported; use recipes with argv arrays' if config.key?('commands')
raise 'enabled must be a boolean' if config.key?('enabled') && config['enabled'] != true && config['enabled'] != false
raise 'environment must be an object' if config.key?('environment') && !config['environment'].is_a?(Hash)
recipes = config.fetch('recipes', [])
raise 'recipes must be an array' unless recipes.is_a?(Array)
puts ["V", config.fetch('enabled', true) ? '1' : '0'].join("\t")
recipes.each do |recipe|
  raise 'each recipe must be an object' unless recipe.is_a?(Hash)
  raise 'recipe.command is unsupported; use recipe.argv' if recipe.key?('command')
  name = field(recipe['name'], 'recipe.name')
  cwd = field(recipe.fetch('cwd', '.'), 'recipe.cwd')
  timeout = recipe.fetch('timeout', 30)
  raise "recipe #{name} has an invalid timeout" unless timeout.is_a?(Integer) && timeout.between?(1, 600)
  argv = recipe['argv']
  raise "recipe #{name} must use a non-empty argv array" unless argv.is_a?(Array) && !argv.empty?
  argv = argv.map { |arg| field(arg, "recipe #{name} argv") }
  source = field(recipe.fetch('source', 'verify.json'), 'recipe.source')
  puts ['R', name, cwd, timeout.to_s, argv.join("\x1f"), source].join("\t")
end
RUBY
      ;;
  esac
}

load_verify_config() {
  local records line kind enabled name cwd timeout argv source
  records="$(mktemp "${TMPDIR:-/tmp}/verify-after-edit-config.XXXXXX")"
  trap 'rm -f -- "$records"' EXIT
  if ! parse_verify_config >"$records"; then
    die "could not read $CONFIG_FILE; use the documented version 1 argv schema"
  fi

  enabled=1
  while IFS=$'\t' read -r kind name cwd timeout argv source; do
    case "$kind" in
      V) enabled="$name" ;;
      R)
        local -a args=()
        IFS="$FIELD_SEPARATOR" read -r -a args <<< "$argv"
        add_recipe "$name" "$cwd" "$timeout" "$source" "${args[@]}"
        ;;
      *) die "could not read $CONFIG_FILE; invalid record" ;;
    esac
  done <"$records"

  [[ "$enabled" == 1 ]] || return 1
  return 0
}

read_package_metadata() {
  local package_file="$1" runtime records kind value
  PACKAGE_MANAGER_FIELD=""
  PACKAGE_SCRIPTS=()
  runtime="$(json_runtime)" || return 0
  records="$(mktemp "${TMPDIR:-/tmp}/verify-after-edit-package.XXXXXX")"
  trap 'rm -f -- "$records"' EXIT

  case "$runtime" in
    node)
      VERIFY_PACKAGE_FILE="$package_file" node <<'NODE' >"$records"
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync(process.env.VERIFY_PACKAGE_FILE, 'utf8'));
if (typeof pkg.packageManager === 'string') console.log(`P\t${pkg.packageManager}`);
if (pkg.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts)) {
  Object.keys(pkg.scripts).sort().forEach((name) => console.log(`S\t${name}`));
}
NODE
      ;;
    python3)
      VERIFY_PACKAGE_FILE="$package_file" python3 - <<'PYTHON' >"$records"
import json
import os
with open(os.environ['VERIFY_PACKAGE_FILE'], encoding='utf-8') as handle:
    package = json.load(handle)
if isinstance(package.get('packageManager'), str):
    print('P\t' + package['packageManager'])
if isinstance(package.get('scripts'), dict):
    for name in sorted(package['scripts']):
        print('S\t' + name)
PYTHON
      ;;
    ruby)
      VERIFY_PACKAGE_FILE="$package_file" ruby <<'RUBY' >"$records"
require 'json'
package = JSON.parse(File.read(ENV.fetch('VERIFY_PACKAGE_FILE')))
puts "P\t#{package['packageManager']}" if package['packageManager'].is_a?(String)
package.fetch('scripts', {}).keys.sort.each { |name| puts "S\t#{name}" } if package['scripts'].is_a?(Hash)
RUBY
      ;;
  esac
  while IFS=$'\t' read -r kind value; do
    case "$kind" in
      P) PACKAGE_MANAGER_FIELD="$value" ;;
      S) PACKAGE_SCRIPTS+=("$value") ;;
    esac
  done <"$records"
  rm -f -- "$records"
  trap - EXIT
}

has_package_script() {
  local wanted="$1" script
  for script in "${PACKAGE_SCRIPTS[@]}"; do
    [[ "$script" == "$wanted" ]] && return 0
  done
  return 1
}

find_lockfile_manager() {
  local directory="$1" lockfile
  NODE_LOCKFILE=""
  while :; do
    for lockfile in pnpm-lock.yaml package-lock.json npm-shrinkwrap.json yarn.lock bun.lock bun.lockb; do
      if [[ -f "$directory/$lockfile" ]]; then
        NODE_LOCKFILE="${directory#"$PROJECT_ROOT"/}/$lockfile"
        [[ "$directory" == "$PROJECT_ROOT" ]] && NODE_LOCKFILE="$lockfile"
        case "$lockfile" in
          pnpm-lock.yaml) printf 'pnpm';;
          package-lock.json|npm-shrinkwrap.json) printf 'npm';;
          yarn.lock) printf 'yarn';;
          bun.lock|bun.lockb) printf 'bun';;
        esac
        return 0
      fi
    done
    [[ "$directory" == "$PROJECT_ROOT" ]] && break
    directory="$(dirname -- "$directory")"
  done
  return 1
}

node_manager_for() {
  local directory="$1" declared="$PACKAGE_MANAGER_FIELD"
  case "$declared" in
    pnpm|pnpm@*) printf 'pnpm'; return 0 ;;
    npm|npm@*) printf 'npm'; return 0 ;;
    yarn|yarn@*) printf 'yarn'; return 0 ;;
    bun|bun@*) printf 'bun'; return 0 ;;
  esac
  find_lockfile_manager "$directory"
}

find_local_bin() {
  local directory="$1" binary="$2" candidate
  while :; do
    candidate="$directory/node_modules/.bin/$binary"
    if [[ -x "$candidate" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
    [[ "$directory" == "$PROJECT_ROOT" ]] && break
    directory="$(dirname -- "$directory")"
  done
  return 1
}

find_python_tool() {
  local directory="$1" binary="$2" candidate
  for candidate in "$directory/.venv/bin/$binary" "$directory/venv/bin/$binary" "$directory/env/bin/$binary"; do
    [[ -x "$candidate" ]] && { printf '%s' "$candidate"; return 0; }
  done
  command -v "$binary" 2>/dev/null || return 1
}

nearest_agents_file() {
  local directory="$1"
  while :; do
    [[ -f "$directory/AGENTS.md" ]] && { printf '%s' "$directory/AGENTS.md"; return 0; }
    [[ "$directory" == "$PROJECT_ROOT" ]] && break
    directory="$(dirname -- "$directory")"
  done
  return 1
}

guidance_tokens() {
  local command="$1" token
  GUIDANCE_TOKENS=()
  IFS=' ' read -r -a GUIDANCE_TOKENS <<< "$command"
  [[ ${#GUIDANCE_TOKENS[@]} -gt 0 ]] || return 1
  for token in "${GUIDANCE_TOKENS[@]}"; do
    [[ "$token" =~ ^[A-Za-z0-9_@%+=:,./-]+$ ]] || return 1
  done
}

load_agents_guidance() {
  local cwd="$1" agents guidance_cwd line trimmed kind command
  GUIDANCE_TYPECHECK=0
  GUIDANCE_LINT=0
  agents="$(nearest_agents_file "$cwd")" || return 0
  guidance_cwd="$(dirname -- "$agents")"

  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="$(trim "$line")"
    case "$trimmed" in
      verify-after-edit:\ typecheck:*)
        kind="typecheck"
        command="$(trim "${trimmed#verify-after-edit: typecheck:}")"
        ;;
      verify-after-edit:\ lint:*)
        kind="lint"
        command="$(trim "${trimmed#verify-after-edit: lint:}")"
        ;;
      *) continue ;;
    esac
    if ! guidance_tokens "$command"; then
      die "$agents has an unsafe verify-after-edit directive; use plain argv tokens, not shell syntax"
    fi
    add_recipe "$kind:guidance" "$guidance_cwd" "$DEFAULT_TIMEOUT" "AGENTS.md" "${GUIDANCE_TOKENS[@]}"
    [[ "$kind" == typecheck ]] && GUIDANCE_TYPECHECK=1 || GUIDANCE_LINT=1
  done <"$agents"
}

file_is_for_target() {
  local target="$1" file="$2"
  [[ "$file" == "$target"/* || "$file" == "$target" ]]
}

target_has_extension() {
  local target="$1" expression="$2" file
  [[ ${#CHANGED_FILES[@]} -eq 0 ]] && return 0
  for file in "${CHANGED_FILES[@]}"; do
    file_is_for_target "$target" "$file" || continue
    [[ "$file" =~ $expression ]] && return 0
  done
  return 1
}

target_inputs() {
  local target="$1" expression="$2" file relative
  TARGET_INPUTS=()
  for file in "${CHANGED_FILES[@]}"; do
    file_is_for_target "$target" "$file" || continue
    [[ "$file" =~ $expression ]] || continue
    relative="${file#"$target"/}"
    TARGET_INPUTS+=("$relative")
  done
  [[ ${#CHANGED_FILES[@]} -gt 0 ]] || TARGET_INPUTS=(".")
}

discover_node_recipes() {
  local cwd="$1" package_file="$cwd/package.json" manager type_script lint_script tsc eslint scope
  [[ -f "$package_file" ]] || return 0
  target_has_extension "$cwd" '\.(ts|tsx|js|jsx|svelte|css)$' || return 0

  read_package_metadata "$package_file"
  scope="$(relative_cwd "$cwd")"
  manager="$(node_manager_for "$cwd" || true)"
  find_lockfile_manager "$cwd" >/dev/null || true
  record_environment_marker "$(manifest_marker "$cwd" package.json)"
  [[ -n "$NODE_LOCKFILE" ]] && record_environment_marker "$NODE_LOCKFILE"
  if [[ -n "$manager" ]] && ! command -v "$manager" >/dev/null 2>&1; then
    manager=""
  fi
  load_agents_guidance "$cwd"

  if [[ "$GUIDANCE_TYPECHECK" == 0 ]]; then
    for type_script in typecheck type-check check-types; do
      has_package_script "$type_script" || continue
      [[ -n "$manager" ]] && add_recipe "typecheck:$scope" "$cwd" "$DEFAULT_TIMEOUT" "package.json scripts.$type_script" "$manager" run "$type_script"
      break
    done
    if ! has_recipe_named "typecheck:$scope" && [[ -f "$cwd/tsconfig.json" ]]; then
      tsc="$(find_local_bin "$cwd" tsc || true)"
      [[ -n "$tsc" ]] && add_recipe "typecheck:$scope" "$cwd" "$DEFAULT_TIMEOUT" "tsconfig.json" "$tsc" --noEmit -p tsconfig.json
    fi
  fi

  if [[ "$GUIDANCE_LINT" == 0 ]]; then
    for lint_script in lint lint:check; do
      has_package_script "$lint_script" || continue
      [[ -n "$manager" ]] && add_recipe "lint:$scope" "$cwd" "$DEFAULT_TIMEOUT" "package.json scripts.$lint_script" "$manager" run "$lint_script"
      break
    done
    if ! has_recipe_named "lint:$scope"; then
      eslint="$(find_local_bin "$cwd" eslint || true)"
      if [[ -n "$eslint" ]] && { [[ -f "$cwd/.eslintrc" || -f "$cwd/.eslintrc.json" || -f "$cwd/.eslintrc.js" || -f "$cwd/.eslintrc.cjs" || -f "$cwd/eslint.config.js" || -f "$cwd/eslint.config.mjs" || -f "$cwd/eslint.config.ts" ]] || grep -q '"eslintConfig"' "$package_file"; }; then
        target_inputs "$cwd" '\.(ts|tsx|js|jsx|svelte|css)$'
        add_recipe "lint:$scope" "$cwd" "$DEFAULT_TIMEOUT" "ESLint configuration" "$eslint" --quiet "${TARGET_INPUTS[@]}"
      fi
    fi
  fi
}

discover_python_recipes() {
  local cwd="$1" config="" tool scope
  [[ -f "$cwd/pyproject.toml" || -f "$cwd/setup.cfg" || -f "$cwd/tox.ini" || -f "$cwd/ruff.toml" || -f "$cwd/.ruff.toml" || -f "$cwd/mypy.ini" || -f "$cwd/pyrightconfig.json" ]] || return 0
  target_has_extension "$cwd" '\.py$' || return 0
  target_inputs "$cwd" '\.py$'
  scope="$(relative_cwd "$cwd")"
  if [[ -f "$cwd/pyproject.toml" ]]; then
    record_environment_marker "$(manifest_marker "$cwd" pyproject.toml)"
  elif [[ -f "$cwd/setup.cfg" ]]; then
    record_environment_marker "$(manifest_marker "$cwd" setup.cfg)"
  elif [[ -f "$cwd/tox.ini" ]]; then
    record_environment_marker "$(manifest_marker "$cwd" tox.ini)"
  elif [[ -f "$cwd/ruff.toml" ]]; then
    record_environment_marker "$(manifest_marker "$cwd" ruff.toml)"
  elif [[ -f "$cwd/.ruff.toml" ]]; then
    record_environment_marker "$(manifest_marker "$cwd" .ruff.toml)"
  elif [[ -f "$cwd/mypy.ini" ]]; then
    record_environment_marker "$(manifest_marker "$cwd" mypy.ini)"
  else
    record_environment_marker "$(manifest_marker "$cwd" pyrightconfig.json)"
  fi

  if [[ -f "$cwd/pyrightconfig.json" ]] || grep -q '^\[tool\.pyright' "$cwd/pyproject.toml" 2>/dev/null; then
    tool="$(find_python_tool "$cwd" pyright || true)"
    [[ -n "$tool" ]] && add_recipe "typecheck:$scope" "$cwd" "$DEFAULT_TIMEOUT" "Python pyright configuration" "$tool" "${TARGET_INPUTS[@]}"
  elif [[ -f "$cwd/mypy.ini" || -f "$cwd/.mypy.ini" ]] || grep -q '^\[tool\.mypy' "$cwd/pyproject.toml" 2>/dev/null; then
    tool="$(find_python_tool "$cwd" mypy || true)"
    [[ -n "$tool" ]] && add_recipe "typecheck:$scope" "$cwd" "$DEFAULT_TIMEOUT" "Python mypy configuration" "$tool" "${TARGET_INPUTS[@]}"
  fi

  if [[ -f "$cwd/ruff.toml" || -f "$cwd/.ruff.toml" ]] || grep -q '^\[tool\.ruff' "$cwd/pyproject.toml" 2>/dev/null; then
    tool="$(find_python_tool "$cwd" ruff || true)"
    [[ -n "$tool" ]] && add_recipe "lint:$scope" "$cwd" "$DEFAULT_TIMEOUT" "Python ruff configuration" "$tool" check "${TARGET_INPUTS[@]}"
  elif [[ -f "$cwd/.flake8" || -f "$cwd/setup.cfg" || -f "$cwd/tox.ini" ]]; then
    tool="$(find_python_tool "$cwd" flake8 || true)"
    [[ -n "$tool" ]] && add_recipe "lint:$scope" "$cwd" "$DEFAULT_TIMEOUT" "Python flake8 configuration" "$tool" "${TARGET_INPUTS[@]}"
  fi
}

discover_go_recipes() {
  local cwd="$1" scope
  [[ -f "$cwd/go.mod" ]] || return 0
  target_has_extension "$cwd" '\.go$' || return 0
  command -v go >/dev/null 2>&1 || return 0
  scope="$(relative_cwd "$cwd")"
  record_environment_marker "$(manifest_marker "$cwd" go.mod)"
  add_recipe "typecheck:$scope" "$cwd" "$DEFAULT_TIMEOUT" "go.mod (offline)" env GOPROXY=off go vet ./...
  add_recipe "test:$scope" "$cwd" "$DEFAULT_TIMEOUT" "go.mod (offline)" env GOPROXY=off go test ./...
}

discover_rust_recipes() {
  local cwd="$1" scope
  [[ -f "$cwd/Cargo.toml" ]] || return 0
  target_has_extension "$cwd" '\.rs$' || return 0
  command -v cargo >/dev/null 2>&1 || return 0
  scope="$(relative_cwd "$cwd")"
  record_environment_marker "$(manifest_marker "$cwd" Cargo.toml)"
  add_recipe "typecheck:$scope" "$cwd" "$DEFAULT_TIMEOUT" "Cargo.toml (offline)" cargo check --offline
  if [[ -f "$cwd/clippy.toml" || -f "$cwd/.clippy.toml" ]]; then
    add_recipe "lint:$scope" "$cwd" "$DEFAULT_TIMEOUT" "clippy configuration (offline)" cargo clippy --offline --all-targets -- -D warnings
  fi
}

discover_ruby_recipes() {
  local cwd="$1" ruby_files tool scope
  [[ -f "$cwd/Gemfile" || -f "$cwd"/*.gemspec ]] || return 0
  target_has_extension "$cwd" '\.rb$' || return 0
  target_inputs "$cwd" '\.rb$'
  scope="$(relative_cwd "$cwd")"
  [[ -f "$cwd/Gemfile" ]] && record_environment_marker "$(manifest_marker "$cwd" Gemfile)"
  command -v ruby >/dev/null 2>&1 && [[ ${#TARGET_INPUTS[@]} -gt 0 ]] && add_recipe "typecheck:$scope" "$cwd" "$DEFAULT_TIMEOUT" "Ruby source" ruby -c "${TARGET_INPUTS[@]}"
  if [[ -f "$cwd/.rubocop.yml" || -f "$cwd/.rubocop.yaml" ]] && command -v bundle >/dev/null 2>&1; then
    add_recipe "lint:$scope" "$cwd" "$DEFAULT_TIMEOUT" "rubocop configuration" bundle exec rubocop "${TARGET_INPUTS[@]}"
  fi
}

discover_target() {
  local cwd="$1"
  discover_node_recipes "$cwd"
  discover_python_recipes "$cwd"
  discover_go_recipes "$cwd"
  discover_rust_recipes "$cwd"
  discover_ruby_recipes "$cwd"
}

find_nearest_manifest_dir() {
  local path="$1" directory
  directory="$(dirname -- "$path")"
  while :; do
    if [[ -f "$directory/package.json" || -f "$directory/pyproject.toml" || -f "$directory/setup.cfg" || -f "$directory/tox.ini" || -f "$directory/go.mod" || -f "$directory/Cargo.toml" || -f "$directory/Gemfile" ]] || compgen -G "$directory/*.gemspec" >/dev/null; then
      printf '%s' "$directory"
      return 0
    fi
    [[ "$directory" == "$PROJECT_ROOT" ]] && break
    directory="$(dirname -- "$directory")"
  done
  printf '%s' "$PROJECT_ROOT"
}

add_target() {
  local target="$1" existing
  for existing in "${TARGET_DIRS[@]}"; do
    [[ "$existing" == "$target" ]] && return 0
  done
  TARGET_DIRS+=("$target")
}

add_changed_file() {
  local raw="$1" candidate directory
  [[ -n "$raw" ]] || return 0
  if [[ "$raw" == /* ]]; then
    candidate="$raw"
  else
    candidate="$PROJECT_ROOT/$raw"
  fi
  directory="$(dirname -- "$candidate")"
  directory="$(cd -P -- "$directory" 2>/dev/null && pwd -P)" || return 0
  candidate="$directory/$(basename -- "$candidate")"
  is_under_root "$candidate" || return 0
  case "$candidate" in
    *.ts|*.tsx|*.js|*.jsx|*.svelte|*.css|*.py|*.go|*.rs|*.rb) CHANGED_FILES+=("$candidate") ;;
  esac
}

extract_hook_paths() {
  local payload="$1" runtime
  [[ -n "$payload" ]] || return 0
  runtime="$(json_runtime || true)"
  case "$runtime" in
    node)
      VERIFY_HOOK_INPUT="$payload" node <<'NODE'
const input = JSON.parse(process.env.VERIFY_HOOK_INPUT);
const values = [input.file_path, input.filePath, input.path, input.tool_input && input.tool_input.file_path, input.tool_input && input.tool_input.filePath, input.tool_input && input.tool_input.path];
for (const value of values) if (typeof value === 'string') console.log(value);
NODE
      ;;
    python3)
      VERIFY_HOOK_INPUT="$payload" python3 - <<'PYTHON'
import json
import os
input = json.loads(os.environ['VERIFY_HOOK_INPUT'])
values = [input.get('file_path'), input.get('filePath'), input.get('path')]
if isinstance(input.get('tool_input'), dict):
    values.extend([input['tool_input'].get('file_path'), input['tool_input'].get('filePath'), input['tool_input'].get('path')])
for value in values:
    if isinstance(value, str): print(value)
PYTHON
      ;;
    ruby)
      VERIFY_HOOK_INPUT="$payload" ruby <<'RUBY'
require 'json'
input = JSON.parse(ENV.fetch('VERIFY_HOOK_INPUT'))
values = [input['file_path'], input['filePath'], input['path']]
values.concat([input['tool_input']['file_path'], input['tool_input']['filePath'], input['tool_input']['path']]) if input['tool_input'].is_a?(Hash)
values.each { |value| puts value if value.is_a?(String) }
RUBY
      ;;
  esac
}

collect_changed_files() {
  local supplied="${VERIFY_AFTER_EDIT_CHANGED_FILES:-}" file payload=""
  if [[ -n "$supplied" ]]; then
    CHANGED_PATHS_PROVIDED=1
    while IFS= read -r file || [[ -n "$file" ]]; do
      add_changed_file "$file"
    done <<< "$supplied"
  fi
  if [[ -n "${CLAUDE_FILE_PATH:-}" ]]; then
    CHANGED_PATHS_PROVIDED=1
    add_changed_file "$CLAUDE_FILE_PATH"
  fi
  if [[ -n "${CURSOR_FILE_PATH:-}" ]]; then
    CHANGED_PATHS_PROVIDED=1
    add_changed_file "$CURSOR_FILE_PATH"
  fi
  if [[ ${#CHANGED_FILES[@]} -eq 0 && ! -t 0 ]]; then
    payload="$(cat 2>/dev/null || true)"
    [[ -n "$payload" ]] && CHANGED_PATHS_PROVIDED=1
    while IFS= read -r file || [[ -n "$file" ]]; do
      add_changed_file "$file"
    done < <(extract_hook_paths "$payload" 2>/dev/null || true)
  fi
}

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '"%s"' "$value"
}

relative_cwd() {
  local cwd="$1"
  [[ "$cwd" == "$PROJECT_ROOT" ]] && { printf '.'; return; }
  printf '%s' "${cwd#"$PROJECT_ROOT"/}"
}

manifest_marker() {
  local cwd="$1" filename="$2" scope
  scope="$(relative_cwd "$cwd")"
  [[ "$scope" == . ]] && { printf '%s' "$filename"; return; }
  printf '%s/%s' "$scope" "$filename"
}

write_manifest() {
  local directory="$PROJECT_ROOT/.recursive" temporary index arg first marker
  [[ ! -e "$CONFIG_FILE" ]] || return 0
  mkdir -p -- "$directory"
  temporary="$(mktemp "$directory/verify.json.XXXXXX")"
  {
    printf '{\n  "version": 1,\n  "enabled": true,\n  "environment": {\n    "source": "auto-discovery",\n    "projectRoot": ".",\n    "detectedFrom": ['
    first=1
    for marker in "${ENVIRONMENT_MARKERS[@]}"; do
      (( first == 0 )) && printf ', '
      json_escape "$marker"
      first=0
    done
    printf ']\n  },\n  "recipes": ['
    for index in "${!RECIPE_NAMES[@]}"; do
      (( index > 0 )) && printf ','
      printf '\n    {\n      "name": '
      json_escape "${RECIPE_NAMES[$index]}"
      printf ',\n      "cwd": '
      json_escape "$(relative_cwd "${RECIPE_CWDS[$index]}")"
      printf ',\n      "argv": ['
      local -a args=()
      IFS="$FIELD_SEPARATOR" read -r -a args <<< "${RECIPE_ARGVS[$index]}"
      first=1
      for arg in "${args[@]}"; do
        (( first == 0 )) && printf ', '
        json_escape "$arg"
        first=0
      done
      printf '],\n      "timeout": %s,\n      "source": ' "${RECIPE_TIMEOUTS[$index]}"
      json_escape "${RECIPE_SOURCES[$index]}"
      printf '\n    }'
    done
    printf '\n  ]\n}\n'
  } >"$temporary"
  mv -- "$temporary" "$CONFIG_FILE"
  printf 'verify-after-edit: wrote reviewable %s\n' "$CONFIG_FILE" >&2
}

print_plan() {
  local index
  for index in "${!RECIPE_NAMES[@]}"; do
    printf '%s\t%s\t%s\t%s\t%s\n' "${RECIPE_NAMES[$index]}" "$(relative_cwd "${RECIPE_CWDS[$index]}")" "${RECIPE_TIMEOUTS[$index]}" "${RECIPE_ARGVS[$index]}" "${RECIPE_SOURCES[$index]}"
  done
}

run_recipe() {
  local index="$1" output status timeout_bin watchdog="" pid
  local -a argv=()
  IFS="$FIELD_SEPARATOR" read -r -a argv <<< "${RECIPE_ARGVS[$index]}"
  output="$(mktemp "${TMPDIR:-/tmp}/verify-after-edit-output.XXXXXX")"
  timeout_bin="$(command -v timeout 2>/dev/null || command -v gtimeout 2>/dev/null || true)"

  if [[ -n "$timeout_bin" ]]; then
    (cd -- "${RECIPE_CWDS[$index]}" && "$timeout_bin" "${RECIPE_TIMEOUTS[$index]}" "${argv[@]}") >"$output" 2>&1 || status=$?
  else
    (
      cd -- "${RECIPE_CWDS[$index]}"
      "${argv[@]}"
    ) >"$output" 2>&1 &
    pid=$!
    (
      sleep "${RECIPE_TIMEOUTS[$index]}"
      kill -TERM "$pid" 2>/dev/null || true
    ) &
    watchdog=$!
    wait "$pid" || status=$?
    kill "$watchdog" 2>/dev/null || true
    wait "$watchdog" 2>/dev/null || true
  fi
  status="${status:-0}"

  if (( status != 0 )); then
    printf '%s\n' "--- ${RECIPE_NAMES[$index]} FAILED (${RECIPE_SOURCES[$index]}) ---" >&2
    sed -n '1,240p' "$output" >&2
    rm -f -- "$output"
    return "$status"
  fi
  rm -f -- "$output"
  return 0
}

main() {
  local target file index failed=0
  is_timeout "$DEFAULT_TIMEOUT" || die "VERIFY_AFTER_EDIT_TIMEOUT must be between 1 and 600 seconds"
  collect_changed_files
  if [[ ${#CHANGED_FILES[@]} -eq 0 && "$CHANGED_PATHS_PROVIDED" == 1 ]]; then
    exit 0
  fi

  if [[ -f "$CONFIG_FILE" ]]; then
    if ! load_verify_config; then
      printf 'verify-after-edit: disabled by %s\n' "$CONFIG_FILE" >&2
      exit 0
    fi
  else
    if [[ ${#CHANGED_FILES[@]} -eq 0 ]]; then
      add_target "$PROJECT_ROOT"
    else
      for file in "${CHANGED_FILES[@]}"; do
        add_target "$(find_nearest_manifest_dir "$file")"
      done
    fi
    for target in "${TARGET_DIRS[@]}"; do
      discover_target "$target"
    done
    [[ "$WRITE_MANIFEST" == 1 || "$MODE" == write ]] && write_manifest
  fi

  case "$MODE" in
    plan) print_plan; exit 0 ;;
    write) exit 0 ;;
    run) ;;
    *) die "VERIFY_AFTER_EDIT_MODE must be run, plan, or write" ;;
  esac

  [[ ${#RECIPE_NAMES[@]} -gt 0 ]] || exit 0
  for index in "${!RECIPE_NAMES[@]}"; do
    run_recipe "$index" || failed=1
  done
  if (( failed != 0 )); then
    printf 'Verification failed after file edit. Fix these errors before proceeding.\n' >&2
    exit 2
  fi
}

main "$@"
