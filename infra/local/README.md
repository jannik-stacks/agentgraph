# Local agentgraph stack

LiteLLM in front of every model, Ollama for local models and the decision API, and one
throwaway container per agent run. Every port binds to 127.0.0.1.

## Commands

From `agentgraph/`:

```sh
cp infra/local/.env.example infra/local/.env   # once: set LITELLM_MASTER_KEY and provider keys
npm run up       # build the sandbox image, start LiteLLM, Postgres, egress and the Ollama relay, wait until healthy
npm run keys     # one proxy key per agent, in infra/local/.keys.env
npm run down     # stop everything, keep volumes
```

`npm run up` again after changing `.env` or `litellm.config.yaml` recreates what changed.

Ollama runs natively on macOS (`brew install ollama` or the app, then `ollama serve`). On Linux,
start it with `docker compose -f infra/local/docker-compose.yml --profile ollama up -d` and set the
two Linux values in `.env`. Pull `qwen3.5:4b` (3.3 GB) and `tev1:0.8b` (0.8 GB). Ollama must be
0.35 or later for `/v1/systemone`.

The compose project is always `agentgraph`. Volumes, networks and the two stateful containers have
fixed names (`agentgraph-pgdata`, `agentgraph-chatgpt-auth`, `agentgraph-db`, `agentgraph-egress`,
`agentgraph-postgres`, `agentgraph-litellm`), so a second project on the same volumes fails at
create instead of sharing the login.

## ChatGPT login for smart, writer and luna

The admin UI has no ChatGPT login, so it runs once from the CLI, before the proxy starts: with
`chatgpt/` models configured and no token, LiteLLM startup waits for the login. The tokens
persist in the `agentgraph-chatgpt-auth` volume. From `infra/local`:

1. `docker compose run --rm --no-deps --entrypoint python3 litellm -c "from litellm.llms.chatgpt.authenticator import Authenticator; Authenticator().get_access_token()"`
2. Open the URL it prints, sign in to ChatGPT, enter the code. Device-code login must be enabled
   in ChatGPT's security settings. A new code can be requested at most every 5 minutes.
3. `npm run up`, then check: `curl -s 127.0.0.1:4000/v1/chat/completions -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H 'Content-Type: application/json' -d '{"model":"smart","messages":[{"role":"user","content":"ping"}]}'`
4. Admin UI at http://127.0.0.1:4000/ui: user `admin`, password = the master key.

A login made with `codex login` imports instead: `CODEX_HOME=$(mktemp -d) codex login`, then
`./chatgpt-import.sh "$CODEX_HOME"`.

The refresh token is single-use: never run two LiteLLM instances against the same volume.

## OpenRouter models

`litellm.config.yaml` routes a flagship and a cheap model per family through OpenRouter: `glm`,
`glm-flash`, `deepseek`, `deepseek-flash`, `minimax`, `gemini`, `gemini-flash`, `grok`, `grok-build`,
`qwen`, `qwen-flash`, `kimi`, `muse` and `muse-flash` (Meta). The OpenRouter key stays in the proxy; bots reach these aliases with
their own virtual keys, and the per-key dollar budget applies to them. Without the key the proxy starts
and only these aliases fail.

1. Add `OPENROUTER_API_KEY=sk-or-...` to `.env`.
2. `npm run up` (recreates the proxy with the new environment and config).
3. `npm run keys` so existing bot keys may use the new aliases.
4. Check: `curl -s 127.0.0.1:4000/v1/chat/completions -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H 'Content-Type: application/json' -d '{"model":"glm-flash","messages":[{"role":"user","content":"ping"}]}'`

## Keys

`npm run keys` creates one virtual key per bot (or updates limits on existing ones) and appends
`AGENTGRAPH_LLM_API_KEY_<BOT>=...` to `.keys.env`. Subscription models report $0 spend, so their
real limits are the per-key rpm/tpm and agentgraph's runs-per-day budget. `ROTATE=1 npm run keys`
replaces every key. The script sends the master key as a header file and new keys on stdin, so neither
shows in a process list.

Fully offline: `LITELLM_CONFIG=litellm.offline.yaml` in `.env`, then `npm run up`.

## A full local run

`e2e.sh` writes the agents' keys from `.keys.env` into a data directory and prints the commands
that run a graph against its GitHub repo: one look at one issue, or a loop over every open issue.
It needs `AGENTGRAPH_APP_ENV` set to the App env file from `bin/setup-app.ts`. Every agent runs
in a sandbox container; without `npm run up`, runs fail and nothing falls back to the host.

```sh
infra/local/e2e.sh /tmp/agentgraph-e2e examples/sandbox
```

## Prices

Runs record what their tokens cost at the public list price, also on a subscription such as the
ChatGPT login, which bills nothing per token. `prices.json.gz` is LiteLLM's price table, pinned to a
release; `npm run prices` fetches it again. `aliases.json` maps each proxy alias to a model the table
lists. A model with no price shows as unpriced, never as $0.
