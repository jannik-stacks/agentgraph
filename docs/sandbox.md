# Sandbox and models

## The sandbox

Sessions, `run` steps, checks and checkout setup run in throwaway Docker containers. Without Docker or the internal network, the run hits a [runner error](workflows.md#order-and-limits). Images are never pulled.

A container has a read-only root, a tmpfs `/tmp`, your non-root uid, no capabilities, `no-new-privileges`, 4g of memory, 1.5 CPUs, 512 pids and a timeout watchdog. No Docker socket or GitHub token enters a session; it gets only its agent's model key. <!-- code: src/docker.ts#dockerArgs -->

| Path | What | Access |
| --- | --- | --- |
| `/work` | The checkout | writable |
| `/home/agent` | The session home | writable |
| `/graph` | The graph, `AGENTGRAPH_DIR`; scripts and setup only | read only |
| `/cache` | The shared toolchain cache; writes stay with the checkout | overlay |
| the mirror | The repo's git objects | read only |

`infra/local/sandbox` builds the image, and its `smoke.sh` tests how containers behave. Tests use a host sandbox that runs in a clone without network rules. <!-- code: tests/doubles/sandbox.ts#hostSandbox -->

## The network

Sessions and setup use the graph's `network`. Scripts and checks get no network. Environment builds use Docker's default network.

| `network` | Docker network | Reachable |
| --- | --- | --- |
| `egress` (default) | `agentgraph-sandbox` | The model proxy, the optional Ollama relay, an HTTPS allowlist |
| `models` | `agentgraph-models` | The model proxy only |

The allowlist in `infra/local/egress/allowlist` has `github.com`, `codeload.github.com`, `objects.githubusercontent.com` and `registry.npmjs.org` for downloads and npm installs, and `api.anthropic.com`, `chatgpt.com` and `auth.openai.com` for harness logins and LiteLLM. Nothing else: no PyPI, crates.io, SSH or browsing.

Graph `setup` installs dependencies, for example `npm ci --no-audit --no-fund`. With `models`, they must already be in the image or the environment. A failed setup retries, then parks the run; an answer retries setup and the step. <!-- code: src/engine.ts#setUp -->

## Environments

An environment caches a repo's dependencies so checkouts do not install them again. To build one, a container takes the files package managers read from the base commit (lockfiles, manifests), installs [toolchains](#toolchains), runs `setup`, and keeps the ignored dependency folders such as `node_modules` and `target`. The files live in the volume `agentgraph-lower-<key>`. <!-- code: src/env.ts#readSandboxSetup src/env.ts#readDependencySkeleton -->

The key covers the base image, the toolchain commands, `setup` and those files, so bases that differ only in source share an environment. A `setup` that reads `$AGENTGRAPH_DIR` runs per checkout instead. Each checkout mounts private overlays over the cached folders, which go when the checkout closes. The trace says which environment each checkout used. <!-- code: src/env.ts#createSharedMounts src/docker.ts#dockerSandbox -->

`AGENTGRAPH_STATE` (default `~/.cache/agentgraph`) holds runner heartbeats, image use times and build locks. Runners that share Docker must share it. One key builds under one lock, so runners that start together reuse the first build. A lock's owner counts as running while its heartbeat is under two minutes old. A missing sandbox image is built; any other missing image fails the checkout with the `docker pull` to run. <!-- code: src/owner.ts#waitForLock src/docker.ts#ensureImage src/owner.ts#isOwnerRunning -->

### Disk

`bin/env.ts` frees disk. It always removes unused volumes, environments no run can reuse, and score trees nobody holds (under `--root` or `AGENTGRAPH_GC_ROOTS`). Then it removes the least recently used until the total is under `AGENTGRAPH_ENV_CAP` (`60g`). It never removes what a container or live checkout uses, what a live runner used in the last `AGENTGRAPH_ENV_HOLD_HOURS` (2), or what a pin names. <!-- code: src/disk.ts#collect -->

```sh
node bin/env.ts list
node bin/env.ts collect --dry-run --root <tune root>
node bin/env.ts pin luna-full 'agentgraph-env/*' --days 14
node bin/env.ts unpin luna-full
node bin/env.ts sweep                 # dependency volumes of dead runners
```

Collection also runs after each bench case, and when less than `AGENTGRAPH_MIN_FREE_GB` (40) is free. If that is not enough, `disk low` names what holds the space and bench work waits. Running containers are never stopped. <!-- code: src/disk.ts#ensureFreeDisk -->

### Toolchains

The sandbox has toolchain managers and a C compiler. The `agentgraph-cache` volume at `/cache` shares rustup, cargo, npm, pnpm and yarn downloads. Only environment builds write it; other writes go to an overlay, and the trace counts them (`cache`).

A root `rust-toolchain` or `rust-toolchain.toml` pins Rust, and `Cargo.toml` alone selects stable with clippy and rustfmt. Graph `toolchain` adds anything else:

```yaml
toolchain: rustup target add wasm32-unknown-unknown && cargo install --locked cargo-nextest
```

A failed install is a runner error. `AGENTGRAPH_CACHE_VOLUME` names another volume, and an empty value turns off the cache and environments. `docker volume rm agentgraph-cache` clears it. <!-- code: src/env.ts#makeToolchainSetupCommands src/env.ts#written -->

## A graph's own image

Graph `image` names a local image for every command and environment build, instead of `AGENTGRAPH_IMAGE` or `agentgraph-sandbox:local`. Build it yourself, with the harnesses; agentgraph never builds or pulls it.

```dockerfile
FROM agentgraph-sandbox:local
USER root
COPY package.json package-lock.json /
RUN npm ci --no-audit --no-fund && npm cache clean --force
ENV PATH=/node_modules/.bin:$PATH
USER node
```

Node finds `/node_modules` from `/work`. Those dependencies stay as built, even when a pull request changes the lockfile. Pair it with `network: models` in `settings.yaml`.

## Harnesses

An agent's `harness` picks the session program by name. The operator's `agentgraph.config.ts`, or the file `AGENTGRAPH_CONFIG` names, lists the harness plugins; a graph never loads code. A plugin is an object with a `name`, the env var its `key` goes in, an optional `home` of files, the `command` to run, a `parse` that turns each JSON output line into events, and an optional `check` that lists what it cannot do. The built-in four in `harnesses/` are written the way yours would be. <!-- code: src/harnesses.ts#Harness src/harnesses.ts#readHarnessSettings -->

`AGENTGRAPH_HARNESS` runs every agent on one harness. Otherwise an agent without a `harness` gets the provider's first, else the config's first. A graph loads only when every agent's harness is in the config and its `check` finds nothing. <!-- code: src/folder.ts#loadGraph -->

| Harness | Tool permissions | Aside fork |
| --- | --- | --- |
| `opencode` | Allowlists with patterns, such as `bash(git diff*)` | `--session <id> --fork` |
| `pi` | Plain tool names only; a pattern fails the graph check | `--fork <id>` |
| `claude` | Claude Code; patterns work, a tool it lacks fails the graph check | `--resume <id> --fork-session` |
| `codex` | `edit`, `write` and `bash` together give every tool; anything else runs read-only. Granting only some of the three fails the graph check. | none, a fresh session |

Agent `tools` defaults to none. Session homes under `homes/` in the data folder persist across resumes. <!-- code: src/harnesses.ts#harnessSession -->

## Models

### Providers

The CLI [picks a provider](cli.md#picking-a-provider): where model calls go and how they log in. `agentgraph.config.ts` lists them. <!-- code: harnesses/providers.ts#makeProviders -->

| Provider | Harness | Ready when |
| --- | --- | --- |
| `claude` | `claude` | its token is in the macOS Keychain or `~/.config/agentgraph/claude-token`, or `CLAUDE_CODE_OAUTH_TOKEN` is set |
| `anthropic` | `claude` | `ANTHROPIC_API_KEY` is set |
| `litellm` | any | `AGENTGRAPH_PROXY_KEYS` is set; agents without a model get `smart`. A ChatGPT subscription comes through here, with LiteLLM holding the login ([local stack](../infra/local/README.md)) |

The first time `claude` is picked, it runs `claude setup-token` on the host, asks for the token and keeps it; each session gets it as `CLAUDE_CODE_OAUTH_TOKEN`. Codex sessions never hold a ChatGPT login: they use the agent's proxy key, and the gateway owns the login.

### Settings

An agent's `model` is the name its endpoint expects, such as a LiteLLM alias or a provider's model id. `AGENTGRAPH_MODELS` maps aliases as `alias=model` pairs, with `*` for agents without a `model`. Without one, opencode and pi ask for `default`.

| Setting | Meaning |
| --- | --- |
| `AGENTGRAPH_PROXY_URL` | The base URL: one, or `harness=url` pairs such as `opencode=http://gateway:4000/v1,claude=http://gateway:4000`. Empty leaves Claude Code on its own login; opencode and pi need a URL. |
| `AGENTGRAPH_PROXY_KEYS` | `agent=key` pairs, `*` for the rest. Without a key, an agent gets the placeholder `none` when its harness has a URL, else its own login. |
| `AGENTGRAPH_SESSION_ENV` | Engine variables every session gets as secrets, such as `CLAUDE_CODE_OAUTH_TOKEN`. Values of 8 or more characters are hidden in output. |

Inside the container the key is `AGENTGRAPH_LLM_API_KEY` for opencode and pi and `ANTHROPIC_AUTH_TOKEN` for Claude Code. Keys pass by environment name, never in arguments. Usage the harness does not price, subscriptions included, is priced from `AGENTGRAPH_PRICES` (`infra/local/prices.json`); a model missing there is `unpriced`, never $0. <!-- code: src/harnesses.ts#priced -->

### Gateways

On a host, the [gateway relay](hosting.md) forwards to `GATEWAY_URL` with `GATEWAY_HEADERS`, a JSON object of headers to set (or remove, when empty), so a provider key can stay in the relay. It keeps the path: opencode and pi call `<url>/chat/completions` or `<url>/responses`, Claude Code calls `<url without /v1>/v1/messages`. On Cloudflare write `gateway.internal` for `gateway:4000`. <!-- code: examples/deploy/gateway/forward.ts#forwardToGateway -->

| Gateway | `GATEWAY_URL` | Credential |
| --- | --- | --- |
| A provider key | `https://api.openai.com` | `GATEWAY_HEADERS={"authorization":"Bearer sk-..."}` |
| LiteLLM | `https://litellm.example.com` | `AGENTGRAPH_PROXY_KEYS=implementor=sk-...,reviewer=sk-...` |
| Vercel AI Gateway | `https://ai-gateway.vercel.sh` | `GATEWAY_HEADERS={"authorization":"Bearer <key>"}` |
| OpenRouter | `https://openrouter.ai/api` | `GATEWAY_HEADERS={"authorization":"Bearer sk-or-..."}` |

A subscription behind LiteLLM works like LiteLLM, with agents on its subscription aliases; run one LiteLLM per login. Cloudflare AI Gateway needs a URL per harness:

```sh
GATEWAY_URL=https://gateway.ai.cloudflare.com/v1/<account>/<gateway>
GATEWAY_HEADERS={"cf-aig-authorization":"Bearer <token>","authorization":""}
AGENTGRAPH_PROXY_URL=opencode=http://gateway:4000/compat,pi=http://gateway:4000/compat,claude=http://gateway:4000/anthropic
```

Claude Code on its own subscription, with no gateway, needs `network: egress`:

```sh
AGENTGRAPH_PROXY_URL=claude=,*=http://gateway:4000/v1
AGENTGRAPH_SESSION_ENV=CLAUDE_CODE_OAUTH_TOKEN
CLAUDE_CODE_OAUTH_TOKEN_FILE=/run/secrets/claude-token
```

## Secrets on the host

- Only `AGENTGRAPH_APP_KEY`, `AGENTGRAPH_PROXY_KEYS` and the `AGENTGRAPH_SESSION_ENV` names may come from a `_FILE`, read once per start. Bench keys stay in the runner's memory. <!-- code: src/main.ts#readEngineEnv bin/bench.ts#readBenchKeys -->
- Host git, docker and environment builds get only `PATH`, `HOME`, `USER`, `TMPDIR`, the locale, `TZ` and the Docker settings. <!-- code: src/git.ts#makeHostEnv -->
- `infra/local/keys.sh` unexports every name in `.env` and every name with `KEY`, `TOKEN`, `SECRET` or `PASSWORD` in it, and curl reads keys from files and stdin, so nothing shows in a process list.
- npm runs no install scripts: the `.npmrc` files set `ignore-scripts=true` and `min-release-age=7`. The sandbox image runs one postinstall by hand, opencode's.
- The studio dev server serves only `studio/`, `src/` and `node_modules/`, and refuses env, key, certificate and `.npmrc` files there. <!-- code: studio/vite.config.ts#deny -->
- On macOS the App key stays in the Keychain; see [Running on GitHub](github.md#the-key).

Code running as your user can still read these keys.

`node bin/leak-probe.ts` looks where an npm worm would: its environment, the repo's ignored files, `~/.agentgraph`, `~/.config/agentgraph`, the process list, containers' environments and the studio's `/@fs` route. It prints where each key-shaped value is, never the value. **Expected** lists keys at rest (`infra/local/.env`, `.keys.env`, the App key, the proxy and database containers); **Look at this** lists copies to remove. It exits 1 on anything to look at and 3 when a probe could not run. `PROBE_PATHS`, `PROBE_STUDIO` and `PROBE_CANARY` change where and what it looks for. <!-- code: bin/leak-probe.ts#secret -->

```sh
node bin/leak-probe.ts
node bin/leak-probe.ts env ps docker
```
