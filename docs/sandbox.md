# Sandbox and models

## The sandbox

Sessions, `run` steps, checks and checkout setup run in throwaway Docker containers. Without Docker or the internal network, the run hits a [runner error](workflows.md#order-and-limits). Images are never pulled.

A container has a read-only root, your non-root uid, no capabilities, `no-new-privileges`, 4g of memory, 1.5 CPUs, 512 pids and a timeout. No Docker socket or GitHub token enters it; a session gets only its agent's model key. <!-- code: src/docker.ts#dockerArgs -->

| Path | What | Access |
| --- | --- | --- |
| `/work` | The checkout | writable |
| `/home/agent` | The session home | writable |
| `/graph` | The graph, `AGENTGRAPH_DIR`; scripts and setup only | read only |
| `/cache` | The shared toolchain cache | overlay |
| the mirror | The repo's git objects | read only |

`infra/local/sandbox` builds the image. <!-- code: tests/doubles/sandbox.ts#hostSandbox -->

## The network

Sessions and setup use the graph's `network`; scripts and checks get none. Environment builds use Docker's default network.

| `network` | Docker network | Reachable |
| --- | --- | --- |
| `egress` (default) | `agentgraph-sandbox` | The model proxy, the optional Ollama relay, an HTTPS allowlist |
| `models` | `agentgraph-models` | The model proxy only |

`infra/local/egress/allowlist` has GitHub's download hosts, `registry.npmjs.org`, and the model login hosts. No PyPI, crates.io, SSH or browsing.

Graph `setup` installs dependencies, such as `npm ci --no-audit --no-fund`. With `models`, they must already be in the image or environment. A failed setup retries, then parks the run; an answer retries setup and the step. <!-- code: src/engine.ts#setUp -->

## Environments

An environment caches a repo's dependencies. A container takes the lockfiles and manifests from the base commit, installs [toolchains](#toolchains), runs `setup`, and keeps the ignored dependency folders such as `node_modules` and `target` in the volume `agentgraph-lower-<key>`. <!-- code: src/env.ts#readSandboxSetup src/env.ts#readDependencySkeleton -->

Bases that differ only in source share one. A `setup` that reads `$AGENTGRAPH_DIR` runs per checkout instead. Each checkout writes to private overlays. <!-- code: src/env.ts#createSharedMounts src/docker.ts#dockerSandbox -->

`AGENTGRAPH_STATE` (`~/.cache/agentgraph`) holds heartbeats, image use times and build locks; runners that share Docker must share it. A missing sandbox image is built; any other missing image fails with the `docker pull` to run. <!-- code: src/owner.ts#waitForLock src/docker.ts#ensureImage src/owner.ts#isOwnerRunning -->

### Disk

`bin/env.ts` frees disk. It removes unused volumes, environments no run can reuse, and score trees nobody holds (under `--root` or `AGENTGRAPH_GC_ROOTS`), then the least recently used until the total is under `AGENTGRAPH_ENV_CAP` (`60g`). It keeps what a container, a live checkout or a pin uses, and what a live runner used in the last `AGENTGRAPH_ENV_HOLD_HOURS` (2). <!-- code: src/disk.ts#collect -->

Its verbs are `list`, `collect --dry-run`, `pin <name> <pattern> --days <n>`, `unpin` and `sweep`, which drops dead runners' dependency volumes. Collection also runs after each bench case and below `AGENTGRAPH_MIN_FREE_GB` (40) free. If that is not enough, `disk low` names what holds the space and bench work waits. <!-- code: src/disk.ts#ensureFreeDisk -->

### Toolchains

The image has toolchain managers and a C compiler. The `agentgraph-cache` volume at `/cache` shares rustup, cargo, npm, pnpm and yarn downloads; only environment builds write it, and the trace counts other writes (`cache`). A `rust-toolchain` file pins Rust, and `Cargo.toml` alone selects stable. Graph `toolchain` adds the rest:

```yaml
toolchain: rustup target add wasm32-unknown-unknown && cargo install --locked cargo-nextest
```

A failed install is a runner error. `AGENTGRAPH_CACHE_VOLUME` names another volume; empty turns off the cache and environments. <!-- code: src/env.ts#makeToolchainSetupCommands src/env.ts#written -->

## A graph's own image

Graph `image` names a local image for every command and environment build, instead of `AGENTGRAPH_IMAGE` or `agentgraph-sandbox:local`. Build it yourself, with the harnesses, for example `FROM agentgraph-sandbox:local` plus an `npm ci` into `/node_modules` on the `PATH`. Those dependencies stay as built even when a pull request changes the lockfile. Pair it with `network: models`.

## Harnesses

An agent's `harness` picks the session program. The operator's `agentgraph.config.ts`, or the file `AGENTGRAPH_CONFIG` names, lists the harness plugins in `harnesses/`; a graph never loads code. A plugin gives a `name`, its `key` variable, a `command`, a `parse` for output lines, and an optional `home` and `check`. <!-- code: src/harnesses.ts#Harness src/harnesses.ts#readHarnessSettings -->

`AGENTGRAPH_HARNESS` runs every agent on one harness. Otherwise an agent without a `harness` gets the provider's first, else the config's first. A graph loads only when every harness is in the config and passes its `check`. <!-- code: src/folder.ts#loadGraph -->

| Harness | Tool permissions | Aside fork |
| --- | --- | --- |
| `opencode` | Patterns, such as `bash(git diff*)` | `--session <id> --fork` |
| `pi` | Plain tool names; a pattern fails the graph check | `--fork <id>` |
| `claude` | Patterns; a tool it lacks fails the graph check; commit and pull request attribution is off | `--resume <id> --fork-session` |
| `codex` | `edit`, `write` and `bash` together give every tool, else read-only; some of the three fails the check | none, a fresh session |

Agent `tools` defaults to none. Session homes under `homes/` in the data folder persist across resumes. <!-- code: src/harnesses.ts#harnessSession -->

## Models

### Providers

The CLI [picks a provider](cli.md#picking-a-provider), listed in `agentgraph.config.ts`. <!-- code: harnesses/providers.ts#makeProviders -->

| Provider | Harness | Ready when |
| --- | --- | --- |
| `claude` | `claude` | its token is in the macOS Keychain or `~/.config/agentgraph/claude-token`, or `CLAUDE_CODE_OAUTH_TOKEN` is set |
| `anthropic` | `claude` | `ANTHROPIC_API_KEY` is set |
| `litellm` | any | `AGENTGRAPH_PROXY_KEYS` is set; agents without a model get `smart`. ChatGPT comes through here ([local stack](../infra/local/README.md)) |

The first pick of `claude` runs `claude setup-token`, joins a token pasted over several lines, tries it with one small `claude -p` call, and keeps it only when that works. Codex sessions never hold a ChatGPT login; the gateway owns it.

### Settings

An agent's `model` is the name its endpoint expects. `AGENTGRAPH_MODELS` maps `alias=model` pairs, `*` for agents without a `model`; without one, opencode and pi ask for `default`.

| Setting | Meaning |
| --- | --- |
| `AGENTGRAPH_PROXY_URL` | One base URL, or `harness=url` pairs. Empty leaves Claude Code on its own login; opencode and pi need one. |
| `AGENTGRAPH_PROXY_KEYS` | `agent=key` pairs, `*` for the rest. Without a key, an agent gets `none` when its harness has a URL, else its own login. |
| `AGENTGRAPH_SESSION_ENV` | Engine variables every session gets as secrets, such as `CLAUDE_CODE_OAUTH_TOKEN`. Values of 8 or more characters are hidden in output. |

In the container the key is `AGENTGRAPH_LLM_API_KEY` for opencode and pi and `ANTHROPIC_AUTH_TOKEN` for Claude Code, passed by name, never in arguments. Every session is priced at its model's public list price, subscriptions too, so runs compare across providers. The table is LiteLLM's, pinned at `infra/local/prices.json.gz` (`AGENTGRAPH_PRICES` names another), and `infra/local/aliases.json` maps proxy aliases to its models. A model the table lacks is `unpriced`, never $0. <!-- code: src/harnesses.ts#priced src/prices.ts#readPrices -->

### Gateways

On a host, the [gateway relay](hosting.md) forwards to `GATEWAY_URL` with `GATEWAY_HEADERS`, a JSON object of headers to set, or remove when empty, so a provider key can stay in the relay. It keeps the path, so Claude Code's base URL drops the `/v1` that opencode and pi use. <!-- code: examples/deploy/gateway/forward.ts#forwardToGateway -->

A provider, OpenRouter (`https://openrouter.ai/api`) or the Vercel AI Gateway takes its key as `GATEWAY_HEADERS={"authorization":"Bearer <key>"}`. A LiteLLM takes per-agent keys in `AGENTGRAPH_PROXY_KEYS` instead. Run one LiteLLM per subscription login. Cloudflare AI Gateway needs `cf-aig-authorization` in `GATEWAY_HEADERS` and a URL per harness: `/compat` for opencode and pi, `/anthropic` for Claude Code.

Claude Code on its own subscription needs `network: egress` and `AGENTGRAPH_PROXY_URL=claude=,*=http://gateway:4000/v1` with `AGENTGRAPH_SESSION_ENV=CLAUDE_CODE_OAUTH_TOKEN`.

## Secrets on the host

- Only `AGENTGRAPH_APP_KEY`, `AGENTGRAPH_PROXY_KEYS` and the `AGENTGRAPH_SESSION_ENV` names may come from a `_FILE`, read once per start. Bench keys stay in the runner's memory. <!-- code: src/main.ts#readEngineEnv bin/bench.ts#readBenchKeys -->
- Host git, docker and environment builds get only `PATH`, `HOME`, `USER`, `TMPDIR`, the locale, `TZ` and the Docker settings. <!-- code: src/git.ts#makeHostEnv -->
- Keys never show in a process list, and npm runs no install scripts (`ignore-scripts=true`, `min-release-age=7`).
- The studio dev server serves only `studio/`, `src/` and `node_modules/`, and refuses env, key, certificate and `.npmrc` files. <!-- code: studio/vite.config.ts#deny -->
- On macOS the App key stays in the Keychain; see [Running on GitHub](github.md#the-key).

Code running as your user can still read these keys.

`node bin/leak-probe.ts` looks where an npm worm would, such as the environment, ignored files, the process list and containers, and prints where each key-shaped value is, never the value. **Look at this** lists copies to remove; it then exits 1, and 3 when a probe could not run. `PROBE_PATHS`, `PROBE_STUDIO` and `PROBE_CANARY` change where and what it looks for. <!-- code: bin/leak-probe.ts#secret -->
