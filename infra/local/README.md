# Local agentgraph stack

LiteLLM in front of every model, Ollama for local models and the decision API, and one
throwaway container per agent run. Every port binds to 127.0.0.1. Commands run from `infra/local`.

## Start

1. `cp .env.example .env`, then set `LITELLM_MASTER_KEY` and any provider keys.
2. Ollama (installs are yours to run). macOS: `brew install ollama` or the app, then
   `ollama serve`. Linux: `docker compose --profile ollama up -d`, and set the two Linux values
   in `.env`. Then pull: `ollama pull qwen3.5:4b` (3.3 GB) and `ollama pull tev1:0.8b` (0.8 GB),
   prefixed with `docker compose exec ollama` on Linux. Ollama must be 0.35 or later for
   `/v1/systemone`.
3. `docker compose up -d` (LiteLLM and Postgres), then `docker compose --profile sandbox up -d`.
4. `docker build -t agentgraph-sandbox:local sandbox` (opencode and pi).

The compose project is always `agentgraph`; never pass `-p`. Volumes, networks and the two stateful
containers have fixed names (`agentgraph-pgdata`, `agentgraph-chatgpt-auth`, `agentgraph-db`,
`agentgraph-egress`, `agentgraph-postgres`, `agentgraph-litellm`), so a second project on the same
volumes fails at create instead of sharing the login.

## Moving from the bothub project

A stack still running as compose project `bothub` moves once with `./migrate-from-bothub.sh`
(`--dry-run` prints the steps). It stops the old project, copies `bothub_pgdata` and
`bothub_chatgpt-auth` into the new volumes, compares them, and starts `agentgraph`. Nothing is
deleted; the script prints the commands that remove the stopped old project later. Run no agents
while it runs.

## ChatGPT login for smart, writer and luna

The admin UI has no ChatGPT login, so it runs once from the CLI, before the proxy starts: with
`chatgpt/` models configured and no token, LiteLLM startup waits for the login. The tokens
persist in the `agentgraph-chatgpt-auth` volume.

1. `docker compose run --rm --no-deps --entrypoint python3 litellm -c "from litellm.llms.chatgpt.authenticator import Authenticator; Authenticator().get_access_token()"`
2. Open the URL it prints, sign in to ChatGPT, enter the code. Device-code login must be enabled
   in ChatGPT's security settings. A new code can be requested at most every 5 minutes.
3. `docker compose up -d`, then check: `curl -s 127.0.0.1:4000/v1/chat/completions -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H 'Content-Type: application/json' -d '{"model":"smart","messages":[{"role":"user","content":"ping"}]}'`
4. Admin UI at http://127.0.0.1:4000/ui: user `admin`, password = the master key.

The refresh token is single-use: never run two LiteLLM instances against the same volume.

## OpenRouter models

`litellm.config.yaml` routes a flagship and a cheap model per family through OpenRouter: `glm`,
`glm-flash`, `deepseek`, `deepseek-flash`, `minimax`, `gemini`, `gemini-flash`, `grok`, `grok-build`,
`qwen`, `qwen-flash`, `kimi`, `muse` and `muse-flash` (Meta). The OpenRouter key stays in the proxy; bots reach these aliases with
their own virtual keys, and the per-key dollar budget applies to them. Without the key the proxy starts
and only these aliases fail.

1. Add `OPENROUTER_API_KEY=sk-or-...` to `.env`.
2. `docker compose up -d litellm` (recreates the proxy with the new environment and config).
3. `./keys.sh` so existing bot keys may use the new aliases.
4. Check: `curl -s 127.0.0.1:4000/v1/chat/completions -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H 'Content-Type: application/json' -d '{"model":"glm-flash","messages":[{"role":"user","content":"ping"}]}'`

## Keys

`./keys.sh` creates one virtual key per bot (or updates limits on existing ones) and appends
`AGENTGRAPH_LLM_API_KEY_<BOT>=...` to `.keys.env`. Copy those lines into `$AGENTGRAPH_DATA/.env`.
Subscription models report $0 spend, so their real limits are the per-key rpm/tpm and agentgraph's
runs-per-day budget. `ROTATE=1 ./keys.sh` replaces every key.

Fully offline: `LITELLM_CONFIG=litellm.offline.yaml` in `.env`, then `docker compose up -d litellm`.

## A full local run

`e2e.sh` writes the agents' keys from `.keys.env` into a data directory and prints the commands
that run a hub against its GitHub repo: one look at one issue, or a loop over every open issue.
It needs `AGENTGRAPH_APP_ENV` set to the App env file from `bin/setup-app.ts`. Every agent runs
in a sandbox container; without the `sandbox` profile up and the image built, runs fail and
nothing falls back to the host.

```sh
./e2e.sh /tmp/agentgraph-e2e ../../examples/sandbox
```

## Prices

The dashboard shows billed cost as the harness reports it and, separately, an estimate at list
prices. Prices come from the proxy's `/model/info` when it has them, then from `prices.json`
(USD per million tokens, aliases mapped to models). The ChatGPT login bills nothing per token, so
smart and writer runs show $0 billed and their list-price estimate.

## Tear down

`docker compose --profile sandbox --profile ollama down` keeps volumes; add
`-v` to drop keys, spend, the ChatGPT login and models.
