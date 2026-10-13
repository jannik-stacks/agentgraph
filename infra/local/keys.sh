#!/usr/bin/env bash
# Creates one LiteLLM virtual key per bot, or updates the limits of keys that already exist.
# New key values are appended to $KEYS_FILE as BOTHUB_LLM_API_KEY_<BOT>=...; the runner hands
# each bot only its own key, as BOTHUB_LLM_API_KEY.
#
#   ./keys.sh             create missing keys, converge budgets and limits on existing ones
#   ROTATE=1 ./keys.sh    delete and recreate every key (old values stop working)
set -euo pipefail
cd "$(dirname "$0")"

[[ -f .env ]] && { set -a; . ./.env; set +a; }
: "${LITELLM_MASTER_KEY:?set LITELLM_MASTER_KEY in infra/local/.env}"
BASE="${LITELLM_URL:-http://127.0.0.1:4000}"
KEYS_FILE="${KEYS_FILE:-.keys.env}"
command -v jq >/dev/null || { echo "keys.sh needs jq" >&2; exit 1; }

# bot | allowed aliases | USD per day | requests per minute | tokens per minute
# Subscription models report $0 spend, so for smart and writer the rpm/tpm limits and
# bothub's runs-per-day budget are what actually bite; the dollar budget covers review.
BOTS=(
  "implementor   smart,writer,fast,local   10  30  400000"
  "reviewer      review,smart,fast,local    5  20  300000"
  "triager       smart,fast,local           1  20  100000"
  "checker       fast,local                 1  30  200000"
  "claim-checker fast,local                 1  30  200000"
)

# Every bot in the example hubs needs a row.
for file in ../../examples/*/bots/*.md; do
  bot=$(basename "$file" .md)
  printf '%s\n' "${BOTS[@]}" | grep -q "^$bot " || echo "warn: $bot (${file#../../}) has no row in keys.sh" >&2
done

api() { # method path [json]
  curl -fsS -X "$1" "$BASE$2" \
    -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H 'Content-Type: application/json' \
    ${3:+--data "$3"}
}

curl -fsS -o /dev/null "$BASE/health/liveliness" || { echo "LiteLLM is not up at $BASE" >&2; exit 1; }
touch "$KEYS_FILE" && chmod 600 "$KEYS_FILE"

for row in "${BOTS[@]}"; do
  read -r bot models budget rpm tpm <<<"$row"
  alias="bh-$bot"
  var="BOTHUB_LLM_API_KEY_$(tr 'a-z-' 'A-Z_' <<<"$bot")"
  limits=$(jq -nc --arg a "$alias" --arg m "$models" --arg bot "$bot" --argjson b "$budget" --argjson r "$rpm" --argjson t "$tpm" \
    '{key_alias: $a, models: ($m | split(",")), max_budget: $b, budget_duration: "1d", rpm_limit: $r, tpm_limit: $t,
      metadata: {bot: $bot, source: "bothub-keys.sh"}}')

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
  api POST /key/generate "$(jq -c --arg k "$value" '. + {key: $k}' <<<"$limits")" >/dev/null
  echo "$var=$value" >>"$KEYS_FILE"
  echo "created $alias ($models, \$$budget/day, $rpm rpm, $tpm tpm)"
done

echo "keys in $KEYS_FILE (mode 600); copy the lines you need into \$BOTHUB_DATA/.env"
