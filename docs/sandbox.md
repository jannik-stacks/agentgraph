# Sandbox and models

## The sandbox

Sessions, `run` steps, checks and checkout setup run in throwaway Docker containers. Without Docker or the internal network, the run hits a [runner error](workflows.md#order-and-limits). Images are never pulled.

A container has a read-only root, your non-root uid, no capabilities, `no-new-privileges`, 4g of memory, 1.5 CPUs, 512 pids and a timeout. No Docker socket or GitHub token enters it; a session gets its model credentials and, when configured, its own tool bearer. <!-- code: src/docker.ts#dockerArgs -->

| Path          | What                                                                       | Access                                                                   |
| ------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `/work`       | The checkout                                                               | writable; read only for a session with no `edit`, `write` or `bash` tool |
| `/scratch`    | Private disk-backed temporary files, outside the checkout; removed with it | writable                                                                 |
| `/tmp`        | Small memory-backed temporary files; 1 GiB, charged to the memory limit    | writable                                                                 |
| `/home/agent` | The session home                                                           | writable                                                                 |
| `/graph`      | The graph, `AGENTGRAPH_DIR`; scripts and setup only                        | read only                                                                |
| `/cache`      | The repo's toolchain cache                                                 | overlay                                                                  |
| the mirror    | The repo's git objects                                                     | read only                                                                |

Before Docker starts, the runner creates folders for mounts nested inside a bind, including dependency volumes under `/work`. Read-only sessions need no setup to create those mountpoints. <!-- code: src/docker.ts#dockerSandbox -->

Docker advertises its `scratch` path in agent prompts. Each checkout gets a separate directory under the runner data folder, mounted at `/scratch`. Normal cleanup and dead-owner cleanup remove it, the latter once the checkout is saved. Use it for isolated source trees, build outputs and screenshots. <!-- code: src/docker.ts#dockerSandbox src/env.ts#removeCheckout -->

A read-only session also gets the mirror, its worktree's git dir and the dependency volumes read only, and keeps package caches in `/tmp`. A box server can't enforce that, so it refuses read-only sessions. <!-- code: src/harnesses.ts#harnessSession src/remote.ts#remoteSandbox -->

`infra/local/sandbox` builds the image. <!-- code: tests/doubles/sandbox.ts#hostSandbox -->

## The network

Sessions and setup use the graph's `network`; scripts and checks get none. Environment builds use Docker's default network.

| `network`          | Docker network       | Reachable                                                                           |
| ------------------ | -------------------- | ----------------------------------------------------------------------------------- |
| `egress` (default) | `agentgraph-sandbox` | The model proxy, the optional Ollama relay, an HTTPS allowlist, selected host tools |
| `models`           | `agentgraph-models`  | The model proxy and selected host tools                                             |

`infra/local/egress/allowlist` has GitHub's download hosts, `registry.npmjs.org`, and the model login hosts. No PyPI, crates.io, SSH or browsing.

Graph `setup` installs dependencies, such as `npm ci --no-audit --no-fund`. With `models`, they must already be in the image or environment. A failed setup retries, then parks the run; an answer retries setup and the step. <!-- code: src/run/checkout.ts#runSetup -->

## Environments

An environment caches a repo's dependencies. A container takes the lockfiles and manifests from the base commit, installs [toolchains](#toolchains), runs `setup`, and keeps the ignored dependency folders such as `node_modules` and `target` in the volume `agentgraph-lower-<key>`. <!-- code: src/env.ts#readSandboxSetup src/env.ts#readDependencySkeleton -->

Bases of one repo that differ only in source share one. Environments of different repos never share a volume. A `setup` that reads `$AGENTGRAPH_DIR` runs per checkout instead. Each checkout writes to private overlays. <!-- code: src/env.ts#createSharedMounts src/docker.ts#dockerSandbox -->

`AGENTGRAPH_STATE` (`~/.cache/agentgraph`) holds heartbeats, image use times and build locks; runners that share Docker must share it. A missing sandbox image is built; any other missing image fails with the `docker pull` to run. A Docker daemon that does not answer fails as unreachable, not as a missing image. <!-- code: src/owner.ts#waitForLock src/docker.ts#ensureImage src/owner.ts#isOwnerRunning -->

### Disk

`bin/env.ts` frees disk. It removes unused volumes, environments and cache volumes no run can reuse, and score trees nobody holds (under `--root` or `AGENTGRAPH_GC_ROOTS`), then the least recently used until the total is under `AGENTGRAPH_ENV_CAP` (`60g`). It keeps what a container, a live checkout or a pin uses, and what a live runner used in the last `AGENTGRAPH_ENV_HOLD_HOURS` (2). A cache volume stays while any environment built with it is left. <!-- code: src/disk.ts#collect -->

Its verbs are `list`, `collect --dry-run`, `pin <name> <pattern> --days <n>`, `unpin` and `sweep`, which drops dead runners' dependency volumes. Bench collection and automatic low-disk collection only consider environment tags and cache volumes recorded in the case or runner data dir (`.envs/refs.jsonl`). A retained environment keeps its shared lower volume and its cache layer, and a live checkout keeps the environment it reads. Global collection stays an explicit operator action. Collection runs below `AGENTGRAPH_MIN_FREE_GB` (40) free. If that is not enough, `disk low` names what holds the space and bench work waits. <!-- code: src/disk.ts#ensureFreeDisk -->

### Toolchains

The image has toolchain managers and a C compiler. Each repo has its own cache volume at `/cache`, named `agentgraph-cache-<repo>-<hash>`. The hash covers the repo (its `repo` name, else its origin URL or path), the image ID and the toolchain lines, both the ones detected from the base's files and graph `toolchain`. It keeps rustup, cargo, npm, pnpm and yarn downloads, so later runs of the same repo reuse them, a changed `setup` keeps them, and other repos never see them. Only environment builds write it, one at a time, and the trace counts other writes (`cache`). A base is trusted when the default branch or a workflow's `base` branch reaches it (bench cases: the clone's `origin/HEAD`). An untrusted base, such as a pull request head under review, gets its own environment, and its build writes `/cache` through an overlay whose writes land in the environment's own `agentgraph-lower-<key>-c` volume, which the build never mounts directly. Trusted runs never execute what it installed. A build while a checkout has the cache mounted does the same. A build that writes the cache in place holds its lock for the whole build, so new checkouts of the repo wait for it. Every build starts from a fresh lower volume, and checkouts refuse a symlink where they expect the environment's dependency copies. Docker without overlay volumes cannot build an untrusted base. Commands outside a checkout get none. A `rust-toolchain` file pins Rust, and `Cargo.toml` alone selects stable. Graph `toolchain` adds the rest:

```yaml
toolchain: rustup target add wasm32-unknown-unknown && cargo install --locked cargo-nextest
```

A failed install is a runner error. `AGENTGRAPH_CACHE_VOLUME` sets another name prefix; empty turns off the caches and environments. Changing the image or toolchain starts a new cache volume, and [disk collection](#disk) removes the old one. <!-- code: src/env.ts#makeToolchainSetupCommands src/env.ts#readSandboxSetup src/env.ts#written -->

## A graph's own image

Graph `image` names a local image for every command and environment build, instead of `AGENTGRAPH_IMAGE` or `agentgraph-sandbox:local`. Build it yourself, with the harnesses, for example `FROM agentgraph-sandbox:local` plus an `npm ci` into `/node_modules` on the `PATH`. Those dependencies stay as built even when a pull request changes the lockfile. Pair it with `network: models`.

The runner resolves the tag to its Docker ID once per checkout, including when caches are disabled. Bench uses the same resolver, with case `image` first, graph `image` second, then `AGENTGRAPH_IMAGE` and the stock sandbox. Custom images must run commands directly and include the harnesses and `agi`; missing custom tags fail without building stock contents. Remote boxes still reject graph image selection. <!-- code: src/docker.ts#readImage -->

For a repo requiring Node 22, build the derived recipe, whose Node source is pinned by digest:

```sh
docker build -t agentgraph-sandbox:node22 infra/local/sandbox/node22
infra/local/sandbox/smoke.sh agentgraph-sandbox:node22
```

Set `image: agentgraph-sandbox:node22` in the repo graph. Node 20, browser and services recipes remain separate.

### A browser

`infra/local/sandbox/browser` adds Playwright's headless Chromium, the libraries it links and one font, about 380 MB. Each Playwright release finds only its own browser build, so build it with the repo's `@playwright/test` version:

```sh
docker build -t agentgraph-sandbox:browser --build-arg PLAYWRIGHT_VERSION=1.60.0 infra/local/sandbox/browser
```

A graph opts in with `image: agentgraph-sandbox:browser`. The image sets `PLAYWRIGHT_BROWSERS_PATH`, so Playwright finds the browser, and `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD`, so `npx playwright test` runs with no network. Tests run headless only.

## Harnesses

An agent's `harness` picks the session program. The operator's `agentgraph.config.ts`, or the file `AGENTGRAPH_CONFIG` names, lists the harness plugins in `harnesses/`. Graphs may load reviewed [host tools](plugins.md). A harness plugin gives a `name`, its `key` variable, a `command`, a `parse` for output lines, a `classify` that returns `read`, `write` or `undefined` for each tool, and an optional `home` and `check`. A name must be classified by its harness or registered as a plugin tool; other names fail the graph check. The sandbox makes the worktree read-only when all harness tools are classified as read; a command may also request read-only access. <!-- code: src/harnesses.ts#Harness src/harnesses.ts#readHarnessSettings -->

The config's `provider` and `harness` select defaults; `AGENTGRAPH_PROVIDER` and `AGENTGRAPH_HARNESS` override them. A selected harness runs every agent. Otherwise an agent without a `harness` gets the provider's first, else the config's first. A graph loads only when every harness is in the config and passes its `check`. <!-- code: src/folder.ts#loadGraph -->

| Harness    | Tool permissions                                                                                                                                                                              | Aside fork                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `opencode` | Patterns, such as `bash(git diff*)`                                                                                                                                                           | `--session <id> --fork`        |
| `pi`       | Plain tool names; a pattern fails the graph check                                                                                                                                             | `--fork <id>`                  |
| `claude`   | Patterns; a tool it lacks fails the graph check; commit and pull request attribution is off                                                                                                   | `--resume <id> --fork-session` |
| `codex`    | `edit`, `write` and `bash` together give every tool, else a read-only `/work`; some of the three fails the check. Codex's own sandbox stays off, as it needs namespaces the container forbids | none, a fresh session          |

An agent with `reads: traces` needs a tool that can read the trace files. The graph author supplies it, and a harness may validate it in `check`. The news file path is included in every agent's prompt and made available to its harness, regardless of tool names.

Agent `tools` defaults to none. Session homes under `homes/` in the data folder persist across resumes; a resume finds its home by name there, so a moved data folder keeps them. <!-- code: src/harnesses.ts#harnessSession -->

## Models

### Providers

The CLI [picks a provider](cli.md#picking-a-provider), listed in `agentgraph.config.ts`. <!-- code: harnesses/providers.ts#makeProviders -->

A provider can give `setup` text for the CLI to show when none is ready or a selected provider is not ready, and `whyLogin` guidance when its recorded session ends with a rejected login. Both are optional. For example, add an entry to the config's `providers` list:

```ts
{ name: 'company', harnesses: ['opencode'], ready: () => !!process.env.COMPANY_KEY,
  setup: 'Export COMPANY_KEY to use the company provider.',
  settings: () => ({ AGENTGRAPH_PROXY_URL: 'https://models.example.com/v1',
    AGENTGRAPH_PROXY_KEYS: `*=${process.env.COMPANY_KEY}` }),
  whyLogin: () => 'Renew COMPANY_KEY and start again.' }
```

A provider can set `auth` to a non-secret mode understood by its harness. The bundled ChatGPT provider sets `auth: chatgpt`, which Pi and Codex accept for direct access. OpenCode also accepts a native provider ID; Pi and Codex reject other direct modes. A proxy URL takes precedence over that mode. With neither a proxy nor an auth mode, a harness uses its native configuration in the isolated session home; it does not inherit the host login. A harness can return `null` for a home file to remove stale configuration on resume.

Recovery runs only for the latest stop caused by a login failure and uses the provider recorded on that session. If the trace has no provider, the CLI gives no provider-specific advice. <!-- code: src/status.ts#findLoginProvider -->

| Provider    | Harness                   | Ready when                                                                                                                               |
| ----------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `claude`    | `claude`                  | its token is in the macOS Keychain or `~/.config/agentgraph/claude-token`, or `CLAUDE_CODE_OAUTH_TOKEN` is set                           |
| `chatgpt`   | `codex`, `opencode`, `pi` | its own login is in `~/.config/agentgraph/codex/auth.json`; offered when `codex login status` passes                                     |
| `anthropic` | `claude`                  | `ANTHROPIC_API_KEY` is set                                                                                                               |
| `litellm`   | any                       | `AGENTGRAPH_PROXY_KEYS` is set; agents without a model get `smart`. ChatGPT comes through here ([local stack](../infra/local/README.md)) |

The first pick of `claude` runs `claude setup-token`, joins a token pasted over several lines, tries it with one small `claude -p` call, and keeps it only when that works.

The first pick of `chatgpt` runs `codex login` with `CODEX_HOME=~/.config/agentgraph/codex`, so agentgraph gets its own login, apart from yours in `~/.codex`. Codex keeps it there in a 0600 file. At each start and before each loop pass, the host refreshes it when less than 2 days remain. Sessions get the access token only, with the refresh token blanked. codex reads it from `/tmp`, opencode from `OPENCODE_AUTH_CONTENT` through its built-in OpenAI login, and pi as the key of a provider that talks to the Codex backend. Agents run `gpt-6.1-sol`, and `fast` runs `gpt-6-luna`. <!-- code: harnesses/providers.ts#chatgpt harnesses/codex.ts#makeCodexHarness harnesses/opencode.ts#opencode harnesses/pi.ts#pi -->

#### A ChatGPT login in sessions

With `chatgpt`, every session holds a working ChatGPT access token, in its environment and in `/tmp`. The token stays valid for up to 10 days. An agent, or a prompt injection in the repo it reads, could leak it, for example in a diff. Output lines are masked, diffs are not. The refresh token stays on the host, so a leaked token stops working when it expires. The Codex backend is not a public API and can change without notice. OpenAI's guidance advises against using a ChatGPT login for automation on public repos. The `litellm` gateway keeps logins out of sessions: they only hold a key you can revoke.

### Settings

An agent's `model` is the name its endpoint expects. `AGENTGRAPH_MODELS` maps `alias=model` pairs, `*` for agents without a `model`; without one, opencode and pi ask for `default`.

| Setting                  | Meaning                                                                                                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AGENTGRAPH_PROXY_URL`   | One base URL, or `harness=url` pairs. Empty leaves Claude Code on its own login; opencode and pi need one.                                                                                                                                                               |
| `AGENTGRAPH_PROXY_KEYS`  | `agent=key` pairs, `*` for the rest. Without a key, an agent gets `none` when its harness has a URL, else its own login.                                                                                                                                                 |
| `AGENTGRAPH_SESSION_ENV` | Only model login variables: `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `AGENTGRAPH_CHATGPT_AUTH` and `OPENCODE_AUTH_CONTENT`. Tracker and plugin service credentials cannot be forwarded through this setting. Values of 8 or more characters are hidden in output. |

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

The harness adapters accept an engine tool endpoint and allow only its named tools. They read its bearer from the reserved session variable `AGENTGRAPH_TOOL_SECRET`. Claude, Codex, OpenCode and Pi support Streamable HTTP. <!-- code: src/trace.ts#SessionSpec src/sandbox.ts#Command harnesses/claude.ts#claude harnesses/codex.ts#makeCodexHarness harnesses/opencode.ts#opencode harnesses/pi.ts#pi -->

Session output and transcripts share credential redaction before storage. Known values and common credential patterns are hidden; this cannot detect every secret. <!-- code: src/context.ts#formatRedactedText src/harnesses.ts#harnessSession src/services.ts#settings -->

Host tools use a session TCP relay on the sandbox's selected internal network. It forwards one port to a loopback listener on macOS or the egress bridge gateway on Linux. The listener checks the relay's source subnet. The relay holds no bearer token and is removed with the session. <!-- code: src/docker.ts#dockerSandbox src/sandbox.ts#Sandbox src/harnesses.ts#harnessSession -->

The sandbox image supplies `agi file put <path>` for selected host-tool sessions. It uses
`AGENTGRAPH_TOOL_URL` and the reserved session bearer to stream a local PNG/JPEG to the session endpoint and prints an opaque handle, with no path or image bytes in model
context. Capture outside `/work`, for example in `/tmp`. Rebuild custom images to include this command.
Remote sandboxes still reject host tools and file passing. See [Plugins](plugins.md).
<!-- code: src/files.ts#makeFiles src/tools.ts#startTools infra/local/sandbox/file.ts#runFile -->
