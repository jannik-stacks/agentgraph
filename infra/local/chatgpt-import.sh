#!/bin/sh
# Imports a ChatGPT login made with `codex login` into LiteLLM's token volume.
# Use a throwaway CODEX_HOME so LiteLLM owns the single-use refresh token alone:
#   CODEX_HOME=$(mktemp -d) codex login && ./chatgpt-import.sh "$CODEX_HOME"
set -eu
src=${1:?usage: chatgpt-import.sh <codex-home>}
test -f "$src/auth.json" || { echo "no auth.json in $src; run codex login first" >&2; exit 1; }
cd "$(dirname "$0")"
docker compose run --rm --no-deps -T \
  -v "$(cd "$src" && pwd)/auth.json:/in/auth.json:ro" \
  --entrypoint python3 litellm -c '
import json, os
t = json.load(open("/in/auth.json")).get("tokens") or {}
missing = [k for k in ("access_token", "refresh_token", "id_token") if not t.get(k)]
if missing:
    raise SystemExit(f"auth.json lacks {missing}; was this a ChatGPT login?")
d = os.environ["CHATGPT_TOKEN_DIR"]
os.makedirs(d, exist_ok=True)
out = {k: t[k] for k in ("access_token", "refresh_token", "id_token")}
if t.get("account_id"):
    out["account_id"] = t["account_id"]
p = os.path.join(d, "auth.json")
with open(p + ".tmp", "w") as f:
    json.dump(out, f)
os.replace(p + ".tmp", p)
print("imported into", p)
'
echo "now remove $src so its refresh token is never used twice, then: docker compose up -d"
