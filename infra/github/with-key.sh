#!/usr/bin/env bash
# Runs bin/run.ts with the App key from the login Keychain on fd 3, which app.env names as /dev/fd/3.
#
#   infra/github/with-key.sh <slug> loop --hub examples/sandbox --data ~/agentgraph-data
set -euo pipefail
slug="${1:?usage: with-key.sh <slug> <run.ts arguments>}"
shift
exec node "${BASH_SOURCE[0]%/*}/../../bin/run.ts" "$@" 3< <(security find-generic-password -s "agentgraph-app-$slug" -w | base64 -d)
