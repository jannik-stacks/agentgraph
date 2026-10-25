#!/usr/bin/env bash
# Creates one LiteLLM virtual key per bot, or updates the limits of keys that already exist.
# New key values are appended to $KEYS_FILE as AGENTGRAPH_LLM_API_KEY_<BOT>=...; the runner hands
# each bot only its own key, as AGENTGRAPH_LLM_API_KEY.
#
#   ./keys.sh             create missing keys, converge budgets and limits on existing ones
#   ROTATE=1 ./keys.sh    delete and recreate every key (old values stop working)
set -euo pipefail
cd "$(dirname "$0")"

# Secrets stay unexported and out of argv: curl gets the key as a header file and the body on stdin.
ENV_FILE="${ENV_FILE:-.env}"
names=$([[ ! -f "$ENV_FILE" ]] || sed -nE 's/^(export )?([A-Za-z_][A-Za-z0-9_]*)=.*/\2/p' "$ENV_FILE")
[[ -f "$ENV_FILE" ]] && . "$ENV_FILE"
export -n LITELLM_MASTER_KEY $names
: "${LITELLM_MASTER_KEY:?set LITELLM_MASTER_KEY in infra/local/.env}"
BASE="${LITELLM_URL:-http://127.0.0.1:4000}"
KEYS_FILE="${KEYS_FILE:-.keys.env}"
command -v jq >/dev/null || { echo "keys.sh needs jq" >&2; exit 1; }

# bot | allowed aliases | USD per day | requests per minute | tokens per minute
# Subscription models report $0 spend, so for smart, writer and luna the rpm/tpm limits and
# agentgraph's runs-per-day budget are what actually bite; the dollar budget covers API-key models.
# Every bot may use the OpenRouter aliases, since a bench point moves every agent of a hub to one model.
OPENROUTER=glm,glm-flash,deepseek,deepseek-flash,minimax,gemini,gemini-flash,grok,grok-build,qwen,qwen-flash,kimi,muse,muse-flash
BOTS=(
  "implementor   smart,writer,fast,local,luna,$OPENROUTER   10  30  400000"
  "reviewer      smart,fast,local,luna,$OPENROUTER           5  60  900000"
  "triager       smart,fast,local,luna,$OPENROUTER           1  30  300000"
  "checker       smart,fast,local,luna,$OPENROUTER           1  30  200000"
  "editor        smart,fast,local,luna,$OPENROUTER           1  30  200000"
  "claim-checker fast,local,luna,$OPENROUTER                 1  30  200000"
  "scout         fast,local,luna,$OPENROUTER                 1  30  200000"
  "router        smart,fast,local,luna,$OPENROUTER           1  30  200000"
  "retro         smart,fast,local,luna,$OPENROUTER           2  30  400000"
  "auditor       smart,fast,local,luna,$OPENROUTER           1  30  400000"
)

# Every bot in the example hubs needs a row.
for file in ../../examples/*/agents/*.md; do
  bot=$(basename "$file" .md)
  printf '%s\n' "${BOTS[@]}" | grep -q "^$bot " || echo "warn: $bot (${file#../../}) has no row in keys.sh" >&2
done

api() { # method path [json]
  curl -fsS -X "$1" "$BASE$2" -H @<(printf 'Authorization: Bearer %s\nContent-Type: application/json\n' "$LITELLM_MASTER_KEY") \
    ${3:+--data-binary @-} <<<"${3:-}"
}

curl -fsS -o /dev/null "$BASE/health/liveliness" || { echo "LiteLLM is not up at $BASE" >&2; exit 1; }
touch "$KEYS_FILE" && chmod 600 "$KEYS_FILE"

for row in "${BOTS[@]}"; do
  read -r bot models budget rpm tpm <<<"$row"
  alias="bh-$bot"
  var="AGENTGRAPH_LLM_API_KEY_$(tr 'a-z-' 'A-Z_' <<<"$bot")"
  limits=$(jq -nc --arg a "$alias" --arg m "$models" --arg bot "$bot" --argjson b "$budget" --argjson r "$rpm" --argjson t "$tpm" \
    '{key_alias: $a, models: ($m | split(",")), max_budget: $b, budget_duration: "1d", rpm_limit: $r, tpm_limit: $t,
      metadata: {bot: $bot, source: "agentgraph-keys.sh"}}')

  exists=$(api GET "/key/list?key_alias=$alias" | jq '.total_count // (.keys | length)')
  if [[ "$exists" != 0 && "${ROTATE:-}" == 1 ]]; then
    api POST /key/delete "$(jq -nc --arg a "$alias" '{key_aliases: [$a]}')" >/dev/null
    sed -i.bak "/^$var=/d" "$KEYS_FILE" && rm -f "$KEYS_FILE.bak"
    exists=0
  fi

  if [[ "$exists" != 0 ]]; then
    api POST /key/update "$limits" >/dev/null
    grep -q "^$var=" "$KEYS_FILE" || echo "warn: $alias exists but $var is not in $KEYS_FILE; rerun with ROTATE=1" >&2
    echo "updated $alias ($models, \$$budget/day, $rpm rpm, $tpm tpm)"
    continue
  fi

  # LiteLLM only accepts custom key values that start with sk-.
  value="sk-bh-$bot-$(openssl rand -hex 16)"
  api POST /key/generate "$(jq -Rc --argjson limits "$limits" '$limits + {key: .}' <<<"$value")" >/dev/null
  echo "$var=$value" >>"$KEYS_FILE"
  echo "created $alias ($models, \$$budget/day, $rpm rpm, $tpm tpm)"
done

echo "keys in $KEYS_FILE (mode 600); copy the lines you need into \$AGENTGRAPH_DATA/.env"
