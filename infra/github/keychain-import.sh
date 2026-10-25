#!/usr/bin/env bash
# Moves an App key from <dir>/<slug>/key.pem into the login Keychain and points app.env at fd 3.
#
#   infra/github/keychain-import.sh <slug> [dir]    dir defaults to ~/.config/agentgraph
set -euo pipefail
slug="${1:?usage: keychain-import.sh <slug> [dir]}"
home="${2:-$HOME/.config/agentgraph}/$slug"
item="agentgraph-app-$slug"
[[ -f "$home/key.pem" ]] || { echo "no key at $home/key.pem" >&2; exit 1; }

key=$(base64 <"$home/key.pem" | tr -d '\n')
printf 'add-generic-password -U -T "" -a agentgraph -s %s -w %s\n' "$item" "$key" | security -i >/dev/null
[[ "$(security find-generic-password -a agentgraph -s "$item" -w)" == "$key" ]] ||
  { echo "the Keychain did not keep the key; $home/key.pem stays" >&2; exit 1; }
sed -i.bak 's|^AGENTGRAPH_APP_KEY_FILE=.*|AGENTGRAPH_APP_KEY_FILE=/dev/fd/3|' "$home/app.env"
rm -f "$home/app.env.bak" "$home/key.pem"
chmod 600 "$home/app.env"
echo "key in the Keychain as $item; start with: npm run with-key -- $slug loop --hub <dir> --data <dir>"
