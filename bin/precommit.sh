#!/bin/sh
# The part of `npm run check` that looks at this repository's uncommitted change, against HEAD or $AGENTGRAPH_BASE:
# docs name coverage, the agentgraph example's fast script checks, and warnings for the other side of every staged docs or
# source change that a docs ref pairs. Safety is left out: its bounds are for bots, not maintainers. Prints every
# finding and fails when a check in block mode has one. Arguments run only those graph checks.
#
#   sh bin/precommit.sh            AGENTGRAPH_BASE=main sh bin/precommit.sh            sh bin/precommit.sh rules size
set -u
cd "$(dirname "$0")/.."
export AGENTGRAPH_DIR="$PWD/examples/agentgraph" AGENTGRAPH_BASE="${AGENTGRAPH_BASE:-HEAD}"
if [ $# -eq 0 ]; then
  node bin/refs.mjs --coverage >/dev/null || { node bin/refs.mjs --coverage | grep -v '^uncited export'; exit 1; }
  rechecks=$(node bin/refs.mjs --diff HEAD --staged)
  [ -z "$rechecks" ] || printf 'docs refs, re-check the other side:\n%s\n' "$rechecks"
  node bin/diagrams.mjs || echo 'diagrams: misaligned (warning only for now)'
  set -- $(node --input-type=module -e "import { fast } from './examples/agentgraph/scripts/fast.mjs'; console.log(fast.filter(c => c !== 'safety').join(' '))")
fi
exec node examples/agentgraph/scripts/fast.mjs "$@"
