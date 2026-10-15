#!/bin/sh
# Runs the bothub hub's fast script checks over this repository's uncommitted change, against HEAD or $BOTHUB_BASE.
# Safety is left out: its bounds are for bots, not maintainers. Prints every finding and fails when a check in block
# mode has one.
#
#   npm run precommit                     BOTHUB_BASE=main npm run precommit          npm run precommit -- rules size
set -u
cd "$(dirname "$0")/.."
export BOTHUB_HUB="$PWD/examples/bothub" BOTHUB_BASE="${BOTHUB_BASE:-HEAD}"
node core/bin/run.ts check --hub examples/sandbox >/dev/null || exit 1
npx --no-install oxfmt --check core/src core/tests >/dev/null || { echo 'core is not formatted: npx oxfmt core/src core/tests'; exit 1; }
[ $# -gt 0 ] || set -- $(node --input-type=module -e "import { fast } from './examples/bothub/scripts/fast.mjs'; console.log(fast.filter(c => c !== 'safety').join(' '))")
exec node examples/bothub/scripts/fast.mjs "$@"
