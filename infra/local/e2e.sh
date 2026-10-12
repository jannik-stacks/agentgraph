#!/usr/bin/env bash
# Prepares a throwaway data directory for a real local run of examples/acme-app with `bothub serve`:
# a copy of the hub, a bare clone of the source repository as origin, and the bots' keys.
#
#   e2e.sh <data-dir> [source-repo]     source-repo defaults to the acme-app checkout above bothub
#
# The copy runs triage on opencode with smart, implement on opencode with smart and review on opencode
# with review (which falls back to smart without an Anthropic key), with at most two attempts and
# short timeouts. The hub's checks install the kit's dependencies inside the sandbox themselves.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
bothub="$(cd "$here/../.." && pwd -P)"
data="${1:?usage: e2e.sh <data-dir> [source-repo]}"
source="${2:-$(cd "$bothub/../../../.." && pwd -P)}"

[[ -e "$data/hub" ]] && { echo "$data/hub exists; use a fresh data directory" >&2; exit 1; }
[[ -f "$here/.keys.env" ]] || { echo "no $here/.keys.env; run keys.sh first" >&2; exit 1; }
mkdir -p "$data"
data="$(cd "$data" && pwd -P)"

cp -R "$bothub/examples/acme-app" "$data/hub"
rm -rf "$data/hub/sims"
hub="$data/hub"
set_field() { # file key value
  sed -i.bak "s#^$2: .*#$2: $3#" "$1" && rm -f "$1.bak"
}
set_field "$hub/bots/triager.md" harness opencode
set_field "$hub/bots/triager.md" model smart
set_field "$hub/bots/implementor.md" harness opencode
set_field "$hub/bots/implementor.md" model smart
set_field "$hub/bots/reviewer.md" harness opencode
set_field "$hub/bots/reviewer.md" model review
sed -i.bak 's/^      max: 3$/      max: 1/; s/timeout-minutes: 45/timeout-minutes: 15/; s/timeout-minutes: 20/timeout-minutes: 8/; s/timeout-minutes: 10/timeout-minutes: 6/' \
  "$hub/workflows/issue.md" && rm -f "$hub/workflows/issue.md.bak"

git clone -q --bare "$source" "$data/origin.git"

{
  echo "BOTHUB_LLM_BASE_URL=http://127.0.0.1:4000/v1"
  grep '^BOTHUB_LLM_API_KEY_' "$here/.keys.env"
} >"$data/.env"
chmod 600 "$data/.env"

cat <<EOF
ready: $data
  hub     $hub
  origin  $data/origin.git (bare clone of $source)

start:   node $bothub/bin/bothub.mjs serve --hub $hub --data $data --repo $data/origin.git --name acme/app
comment: $here/comment.sh $hub 6 '/bothub add kit/tests/smoke.test.ts with one test that the public index exports something'
EOF
