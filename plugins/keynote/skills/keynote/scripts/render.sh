#!/bin/sh
# Render a keynote film with the keynote engine (@recursive/demo-engine).
#   render.sh FILM.json OUT_DIR [--narrate] [--still S | --stills a,b,c] [--preview] [--lint]
# Engine lookup: $KEYNOTE_ENGINE (a demo-engine checkout), else packages/demo-engine in a
# Recursive checkout above this kit. Narration/music keys come from the environment
# (ELEVENLABS_API_KEY); load the project's .env first if it keeps them there.
set -e
here=$(cd "$(dirname "$0")" && pwd -P)
engine=${KEYNOTE_ENGINE:-}
if [ -z "$engine" ]; then
  d=$here
  while [ "$d" != "/" ]; do
    if [ -f "$d/packages/demo-engine/src/cli.ts" ]; then engine="$d/packages/demo-engine"; break; fi
    d=$(dirname "$d")
  done
fi
if [ -z "$engine" ] || [ ! -f "$engine/src/cli.ts" ]; then
  echo "keynote: engine not found. Set KEYNOTE_ENGINE to a Recursive checkout's packages/demo-engine." >&2
  exit 2
fi
tsx=""
for c in "$engine/node_modules/.bin/tsx" "$engine/../../node_modules/.bin/tsx"; do [ -x "$c" ] && tsx=$c && break; done
if [ -z "$tsx" ]; then tsx="npx tsx"; fi
film=$1; shift
case "$1" in --lint) exec $tsx "$engine/src/cli.ts" keynote "$film" --lint ;; esac
exec $tsx "$engine/src/cli.ts" keynote "$film" "$@"
