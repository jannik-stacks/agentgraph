#!/usr/bin/env bash
# Prepares a data directory for a real local run of a hub against its GitHub repo, and prints the commands.
#
#   e2e.sh <data-dir> [hub]     hub defaults to examples/sandbox
#
# Needs the local stack up (README), the sandbox image built, .keys.env from keys.sh, and BOTHUB_APP_ENV naming
# the App env file that bin/setup-app.ts wrote. Nothing runs here.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
bothub="$(cd "$here/../.." && pwd -P)"
data="${1:?usage: e2e.sh <data-dir> [hub]}"
hub="$(cd "${2:-$bothub/examples/sandbox}" && pwd -P)"

[[ -f "$here/.keys.env" ]] || { echo "no $here/.keys.env; run keys.sh first" >&2; exit 1; }
[[ -n "${BOTHUB_APP_ENV:-}" ]] || { echo "set BOTHUB_APP_ENV to the App env file" >&2; exit 1; }
node "$bothub/bin/run.ts" check --hub "$hub" >/dev/null
mkdir -p "$data"
data="$(cd "$data" && pwd -P)"

keys="$(sed -n 's/^BOTHUB_LLM_API_KEY_\([A-Z0-9_]*\)=\(.*\)$/\1=\2/p' "$here/.keys.env" |
  awk '{ i = index($0, "="); n = tolower(substr($0, 1, i - 1)); gsub("_", "-", n); printf "%s%s=%s", sep, n, substr($0, i + 1); sep = "," }')"
printf 'BOTHUB_PROXY_KEYS=%s\n' "$keys" >"$data/.env"
chmod 600 "$data/.env"

cat <<EOF
ready: $data
  hub   $hub

load the keys:  set -a; . $data/.env; set +a
one issue:      node $bothub/bin/run.ts --hub $hub --issue <n> --data $data
every issue:    node $bothub/bin/run.ts loop --hub $hub --data $data
needs you:      node $bothub/bin/run.ts status --hub $hub --data $data
EOF
