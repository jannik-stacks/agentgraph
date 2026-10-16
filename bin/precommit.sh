#!/bin/sh
# Runs the bothub hub's fast script checks over this repository's uncommitted change, against HEAD or $BOTHUB_BASE.
# Safety is left out: its bounds are for bots, not maintainers. Prints every finding and fails when a check in block
# mode has one.
#
#   npm run precommit                     BOTHUB_BASE=main npm run precommit          npm run precommit -- rules size
set -u
cd "$(dirname "$0")/.."
export BOTHUB_HUB="$PWD/examples/bothub" BOTHUB_BASE="${BOTHUB_BASE:-HEAD}"
if [ $# -eq 0 ]; then
  for hub in examples/*/hub.yaml; do node bin/run.ts check --hub "${hub%/hub.yaml}" >/dev/null || exit 1; done
  node bin/fields.mjs || exit 1
  node bin/refs.mjs >/dev/null || { node bin/refs.mjs; exit 1; }
  node bin/diagrams.mjs || echo 'diagrams: misaligned (warning only for now)'
  npx --no-install knip >/dev/null || { npx --no-install knip; exit 1; }
  npx --no-install oxfmt --check src tests bin >/dev/null || { echo 'not formatted: npx oxfmt src tests bin'; exit 1; }
  set -- $(node --input-type=module -e "import { fast } from './examples/bothub/scripts/fast.mjs'; console.log(fast.filter(c => c !== 'safety').join(' '))")
fi
exec node examples/bothub/scripts/fast.mjs "$@"
