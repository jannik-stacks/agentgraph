# Local bothub stack

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
4. `docker build -t bothub-sandbox:local sandbox` (opencode and pi).

## ChatGPT login for smart, writer and luna

The admin UI has no ChatGPT login, so it runs once from the CLI, before the proxy starts: with
`chatgpt/` models configured and no token, LiteLLM startup waits for the login. The tokens
persist in the `chatgpt-auth` volume.

1. `docker compose run --rm --no-deps --entrypoint python3 litellm -c "from litellm.llms.chatgpt.authenticator import Authenticator; Authenticator().get_access_token()"`
2. Open the URL it prints, sign in to ChatGPT, enter the code. Device-code login must be enabled
   in ChatGPT's security settings. A new code can be requested at most every 5 minutes.
3. `docker compose up -d`, then check: `curl -s 127.0.0.1:4000/v1/chat/completions -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H 'Content-Type: application/json' -d '{"model":"smart","messages":[{"role":"user","content":"ping"}]}'`
4. Admin UI at http://127.0.0.1:4000/ui: user `admin`, password = the master key.

The refresh token is single-use: never run two LiteLLM instances against the same volume.

## Keys

`./keys.sh` creates one virtual key per bot (or updates limits on existing ones) and appends
`BOTHUB_LLM_API_KEY_<BOT>=...` to `.keys.env`. Copy those lines into `$BOTHUB_DATA/.env`.
Subscription models report $0 spend, so their real limits are the per-key rpm/tpm and bothub's
runs-per-day budget. `ROTATE=1 ./keys.sh` replaces every key.

Fully offline: `LITELLM_CONFIG=litellm.offline.yaml` in `.env`, then `docker compose up -d litellm`.

## A full local run

`e2e.sh` writes the agents' keys from `.keys.env` into a data directory and prints the commands
that run a hub against its GitHub repo: one look at one issue, or a loop over every open issue.
It needs `BOTHUB_APP_ENV` set to the App env file from `bin/setup-app.ts`. Every agent runs
in a sandbox container; without the `sandbox` profile up and the image built, runs fail and
nothing falls back to the host.

```sh
./e2e.sh /tmp/bothub-e2e ../../examples/sandbox
```

## Prices

The dashboard shows billed cost as the harness reports it and, separately, an estimate at list
prices. Prices come from the proxy's `/model/info` when it has them, then from `prices.json`
(USD per million tokens, aliases mapped to models). The ChatGPT login bills nothing per token, so
smart and writer runs show $0 billed and their list-price estimate.

## Tear down

`docker compose --profile sandbox --profile ollama down` keeps volumes; add
`-v` to drop keys, spend, the ChatGPT login and models.
