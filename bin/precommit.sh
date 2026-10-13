#!/bin/sh
# Runs the bothub hub's cheap script checks over this repository's uncommitted change, against HEAD or $BOTHUB_BASE,
# with each check's own command. Prints every finding and fails when a check in block mode has one.
#
#   npm run precommit                     BOTHUB_BASE=main npm run precommit
set -u
cd "$(dirname "$0")/.."
checks=examples/bothub/checks
export BOTHUB_HUB="$PWD/examples/bothub" BOTHUB_BASE="${BOTHUB_BASE:-HEAD}"
failed=0
for check in size rules unused-exports propagation; do
  mode=$(sed -n 's/^mode: *//p' "$checks/$check.md")
  sh -c "$(sed -n 's/^run: *//p' "$checks/$check.md")" && continue
  echo "$check: the findings above are $mode"
  if [ "$mode" = block ]; then failed=1; fi
done
exit $failed
