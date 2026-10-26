# Local model stack

LiteLLM in front of every model, Ollama for local models, an egress proxy, and the sandbox image. Every port binds to 127.0.0.1.

## Commands

From a checkout of agentgraph:

```sh
cp infra/local/.env.example infra/local/.env   # once: set LITELLM_MASTER_KEY and provider keys
npm run up       # start LiteLLM, Postgres, egress and the Ollama relay, wait until healthy
npm run keys -- local   # one proxy key for every agent, in infra/local/.keys.env.local
npm run keys     # one proxy key per bot of the example graphs, in infra/local/.keys.env
npm run down     # stop everything, keep volumes
```

Run `npm run up` again after changing `.env` or `litellm.config.yaml`. `e2e.sh` turns `.keys.env` into `AGENTGRAPH_PROXY_KEYS` for a data folder; see [Running on GitHub](../../docs/github.md#start-the-runner).

Ollama runs natively on macOS (`brew install ollama`, then `ollama serve`). On Linux, start it with `docker compose -f infra/local/docker-compose.yml --profile ollama up -d` and set the two Linux values in `.env`. Pull `qwen3.5:4b` and `tev1:0.8b`; Ollama must be 0.35 or later.

The compose project is always `agentgraph`, and its volumes, networks and stateful containers have fixed `agentgraph-` names, so a second project fails at create instead of sharing the login.

Fully offline: set `LITELLM_CONFIG=litellm.offline.yaml` in `.env`, then `npm run up`.

## ChatGPT login for smart, writer and luna

Log in once, before the proxy starts; the tokens persist in the `agentgraph-chatgpt-auth` volume. From `infra/local`:

1. `docker compose run --rm --no-deps --entrypoint python3 litellm -c "from litellm.llms.chatgpt.authenticator import Authenticator; Authenticator().get_access_token()"`
2. Open the URL, sign in and enter the code. Device-code login must be on in ChatGPT's security settings.
3. `npm run up`, then check: `curl -s 127.0.0.1:4000/v1/chat/completions -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H 'Content-Type: application/json' -d '{"model":"smart","messages":[{"role":"user","content":"ping"}]}'`
4. The admin UI is at http://127.0.0.1:4000/ui: user `admin`, password the master key.

A `codex login` imports instead: `CODEX_HOME=$(mktemp -d) codex login`, then `./chatgpt-import.sh "$CODEX_HOME"`. The refresh token is single use, so never run two LiteLLM instances on the same volume.

## OpenRouter models

`litellm.config.yaml` routes a flagship and a cheap model per family through OpenRouter, such as `glm` and `glm-flash`; `aliases.json` lists them all. The OpenRouter key stays in the proxy, and the per-key dollar budget applies.

1. Add `OPENROUTER_API_KEY=sk-or-...` to `.env`.
2. `npm run up`, then `npm run keys` so existing keys may use the new aliases.
3. Check with the curl above, using `glm-flash`.

## Keys

`npm run keys` creates one virtual key per agent, or updates existing limits, and appends `AGENTGRAPH_LLM_API_KEY_<AGENT>=...` to `.keys.env`. Subscription models spend $0, so their limits are rpm and tpm. `ROTATE=1 npm run keys` replaces every key. Keys never show in a process list.

`prices.json.gz` is LiteLLM's price table, pinned to a release, and `npm run prices` fetches it again; see [Models](../../docs/sandbox.md#models).
