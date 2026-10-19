#!/bin/sh
# Generate or edit plates with Codex image generation, several in parallel (keynote kit).
#   gen.sh JOBS.tsv OUT_DIR
# JOBS.tsv: one job per line, tab-separated:  name <TAB> refs <TAB> prompt
#   refs: comma-separated image paths attached with -i (the first is the image to edit, for edits);
#         "-" for none. Each job runs in OUT_DIR/<name>/ and must save plate.png there.
# The prompt goes on stdin: codex's -i is variadic and swallows a positional prompt.
# Existing OUT_DIR/<name>/plate.png is kept (delete it to regenerate). Waits for all jobs.
set -e
jobs=$1; out=$2
[ -f "$jobs" ] && [ -n "$out" ] || { echo "usage: gen.sh JOBS.tsv OUT_DIR" >&2; exit 2; }
mkdir -p "$out"
pids=""
while IFS="$(printf '\t')" read -r name refs prompt; do
  [ -z "$name" ] && continue
  case "$name" in \#*) continue ;; esac
  dir="$out/$name"; mkdir -p "$dir"
  [ -f "$dir/plate.png" ] && { echo "keep  $name"; continue; }
  set --
  if [ "$refs" != "-" ]; then
    old=$IFS; IFS=,; for r in $refs; do set -- "$@" -i "$r"; done; IFS=$old
  fi
  ( cd "$dir" && printf '%s\n\nSave the image as plate.png in the current directory.' "$prompt" \
      | codex exec --skip-git-repo-check --sandbox workspace-write -C . "$@" > log.txt 2>&1 ) &
  pids="$pids $!"
  echo "start $name"
done < "$jobs"
for p in $pids; do wait "$p" || true; done
fail=0
while IFS="$(printf '\t')" read -r name refs prompt; do
  [ -z "$name" ] && continue; case "$name" in \#*) continue ;; esac
  if [ -f "$out/$name/plate.png" ]; then echo "ok    $name $(sips -g pixelWidth -g pixelHeight "$out/$name/plate.png" 2>/dev/null | awk '/pixel/{printf "%s ", $2}')"; else echo "FAIL  $name (see $out/$name/log.txt)"; fail=1; fi
done < "$jobs"
exit $fail
