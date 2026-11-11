# Sandbox and models

## The sandbox

Sessions, `run` steps, checks and checkout setup execute through a [runner](#runners). The `local` runner uses throwaway Docker containers and never pulls command images. For `local`, missing Docker or the internal network is an [engine error](workflows.md#order-and-limits). The `box` runner sends commands to a box server over HTTP; plugins can execute them on other hosts. <!-- code: src/docker.ts#dockerArgs src/remote.ts#boxRunner -->

A `local` runner container has a read-only root, your non-root uid, no capabilities, `no-new-privileges`, 4g of memory and 1.5 CPUs by default, 512 pids and a timeout. No Docker socket or GitHub token enters it; a session gets its model credentials and, when configured, its own tool bearer. <!-- code: src/docker.ts#dockerArgs -->

Set graph-wide resource limits in `settings.yaml`:

```yaml
limits:
  memory: 8g
  cpus: 4
```

A step can override memory or CPUs with `limits: { memory: 8g }`; its session, scripts and checks use those limits. Asides use their `back` target's limits. See the [limits reference](reference.md#settingsyaml) for ranges. `/tmp` counts toward memory. The `box` runner rejects resource overrides. <!-- code: src/run/follow.ts#runAside src/types.ts#CommandLimits src/run/attempt.ts#runAttempt src/run/execute.ts#runShell src/run/execute.ts#makeAgentSessionSpec src/remote.ts#whyBoxRefused src/services.ts#whyRunnerRefuses -->

| Path          | What                                                                       | Access                                                     |
| ------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `/work`       | The checkout                                                               | writable; read only for sessions whose tools are read-only |
| `/scratch`    | Private disk-backed temporary files, outside the checkout; removed with it | writable                                                   |
| `/tmp`        | Small memory-backed temporary files; 1 GiB, charged to the memory limit    | writable                                                   |
| `/home/agent` | The session home                                                           | writable                                                   |
| `/graph`      | The graph, `AGENTGRAPH_DIR`; scripts and setup only                        | read only                                                  |
| `/cache`      | The repo's toolchain cache                                                 | overlay                                                    |
| `/news`       | The news file, check inputs and traces the engine writes                   | read only                                                  |
| the mirror    | The repo's git objects                                                     | read only                                                  |

<!-- code: src/sandbox.ts#inside src/docker.ts#dockerArgs -->

The local runner creates nested mountpoints before starting Docker, including for read-only commands. <!-- code: src/docker.ts#dockerRunner -->

Prompts and `AGENTGRAPH_*` file variables name sandbox paths. `/scratch` is private to the checkout and removed during cleanup. <!-- code: src/sandbox.ts#inside src/run/attempt.ts#runAttempt src/docker.ts#dockerRunner src/env.ts#getCheckoutPaths src/env.ts#removeCheckout src/mirror.ts#makeSandbox -->

Read-only sessions mount the mirror, git directory and dependencies read-only. The box runner enforces read-only commands with a separate user and clears leftover writable processes. <!-- code: src/harnesses.ts#harnessSession src/remote.ts#makeBoxRunner -->

`infra/local/sandbox` builds the image. <!-- code: src/docker.ts#ensureImage -->

### Runners

A runner executes commands; the engine owns git, checkouts and publishing. `local` checks Docker, builds stock images and creates networks. `box` uses `AGENTGRAPH_SANDBOX_URL`; see [Hosting](hosting.md#cloudflare). [Runner plugins](plugins.md#runners), such as the Modal example, add other hosts. <!-- code: src/sandbox.ts#Runner src/mirror.ts#makeSandbox src/runners.ts#local src/docker.ts#ensureDockerHost src/services.ts#makeRunner src/runners.ts#box src/remote.ts#boxRunner src/plugin.ts#RunnerHost examples/plugins/modal/modal.ts#makeModalRunner -->

`--runner` or [instance settings](local.md#named-instances-and-settings) select the runner. `agi check` and the loop reject unsupported graphs before starting. Runners must preserve read-only access and network restrictions; `box` cannot provide custom images, resource overrides or host tools. <!-- code: src/main.ts#readInstanceEnv src/services.ts#hostSettings src/services.ts#whyRunnerRefuses bin/run.ts#loadServedGraph src/remote.ts#whyBoxRefused src/sandbox.ts#Runner -->

## The network

Sessions and setup use the graph's `network`; scripts and checks get none. Environment builds use Docker's default network.

| `network`          | Docker network       | Reachable                                                                           |
| ------------------ | -------------------- | ----------------------------------------------------------------------------------- |
| `egress` (default) | `agentgraph-sandbox` | The model proxy, the optional Ollama relay, an HTTPS allowlist, selected host tools |
| `models`           | `agentgraph-models`  | The model proxy and selected host tools                                             |

`infra/local/egress/allowlist` has GitHub's download hosts, `registry.npmjs.org`, and the model login hosts. No PyPI, crates.io, SSH or browsing.

Graph `setup` installs dependencies, such as `npm ci --no-audit --no-fund`. With `models`, they must already be in the image or environment. A failed setup retries, then parks the run; an answer retries setup and the step. <!-- code: src/run/checkout.ts#runSetup -->

## Environments

An environment caches dependencies installed from the base commit's manifests and lockfiles, graph setup and toolchains. Ignored dependency folders live in a reusable volume. <!-- code: src/env.ts#readSandboxSetup src/env.ts#readDependencySkeleton src/env.ts#makeSetupVolumeName -->

Bases differing only in source can share an environment; repositories never share one. Each checkout writes private overlays. Setup that reads `$AGENTGRAPH_DIR` runs per checkout. <!-- code: src/env.ts#createSharedMounts src/docker.ts#dockerRunner -->

Runs using only read-only agents skip environments, cache volumes and setup; their scripts and checks have no installed dependencies. <!-- code: src/folder.ts#loadGraph src/run/drive.ts#runWorkflow src/docker.ts#dockerRunner -->

`AGENTGRAPH_STATE` (`~/.cache/agentgraph`) holds heartbeats and build locks; hosts sharing Docker must share it. Missing stock images are built; missing custom images and unreachable Docker fail with a reason. <!-- code: src/owner.ts#readStateDir src/owner.ts#waitForLock src/docker.ts#ensureImage src/owner.ts#isOwnerRunning -->

### Disk

`bin/env.ts` lists, collects, pins and unpins cached environments. `AGENTGRAPH_ENV_HOLD_HOURS` (2) sets live-process hold time. Collection preserves live holds, pins and cache layers needed by retained environments, then removes least recently used data to meet `AGENTGRAPH_ENV_CAP` (60g). <!-- code: src/disk.ts#collect -->

Below `AGENTGRAPH_MIN_FREE_GB` (40) GB free, checked before a sandbox setup is built, automatic collection considers only references recorded in the instance or case, and never the image the current work needs. If it cannot free enough, the engine prints one `disk low` warning naming free space and the floor, and work goes on. `AGENTGRAPH_DISK_LOW=block` makes work wait with that reason instead; `AGENTGRAPH_MIN_FREE_GB=0` turns the check off. Global collection is an explicit operator action; `sweep` removes dead processes' orphaned volumes. <!-- code: src/disk.ts#ensureFreeDisk src/env.ts#removeOrphanedVolumes -->

### Toolchains

Each repository has a toolchain cache at `/cache`, keyed by repository, image ID and toolchain commands. It reuses package downloads across setup changes. Trusted builds write under a lock; untrusted bases and builds overlapping active checkouts use private overlays. Graph `toolchain` supplies extra installs:

```yaml
toolchain: rustup target add wasm32-unknown-unknown && cargo install --locked cargo-nextest
```

Failed toolchain installation is an engine error. `AGENTGRAPH_CACHE_VOLUME` changes the cache prefix; an empty value disables caches and environments. Image or toolchain changes create another cache; [collection](#disk) removes old ones. <!-- code: src/env.ts#makeToolchainSetupCommands src/env.ts#readSandboxSetup src/env.ts#makeLayerVolumeName src/env.ts#written src/services.ts#settings -->

## A graph's own image

Graph `image` selects a local command and environment image; [instance settings](local.md#named-instances-and-settings) can override it. Custom images must include the harnesses and `agi`, and execute commands directly.

The local runner pins the Docker image ID per checkout, even without caches. Bench uses the same resolver. Missing custom tags fail without a stock-image build; `box` rejects graph images. <!-- code: src/docker.ts#readImage src/remote.ts#whyBoxRefused -->

For example, build the Node 22 recipe:

```sh
docker build -t agentgraph-sandbox:node22 infra/local/sandbox/node22
infra/local/sandbox/smoke.sh agentgraph-sandbox:node22
```

Select it with `image: agentgraph-sandbox:node22`.

### A browser

The optional browser image adds headless Chromium. Build it with the repository's Playwright version:

```sh
docker build -t agentgraph-sandbox:browser --build-arg PLAYWRIGHT_VERSION=1.60.0 infra/local/sandbox/browser
```

Select it with `image: agentgraph-sandbox:browser`. The image provides Playwright's browser path and disables browser downloads for offline tests.

## Harnesses

An agent's `harness` selects a session program from the operator config. A harness supplies its package, command, output parser and tool classifications, plus optional session-home files and validation. Unknown tools fail validation; sessions with only read-classified tools receive a read-only checkout. <!-- code: src/harnesses.ts#Harness src/harnesses.ts#readHarnessSettings -->

Config defaults can be overridden with `AGENTGRAPH_PROVIDER` and `AGENTGRAPH_HARNESS`. A selected harness overrides agent choices; otherwise the provider's first harness, then the config's first, supplies the default. Every used harness must be configured and pass validation. <!-- code: src/folder.ts#loadGraph -->

| Harness    | Tool permissions                                                                                                                                                                              | Aside fork                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `opencode` | Patterns, such as `bash(git diff*)`                                                                                                                                                           | `--session <id> --fork`        |
| `pi`       | Plain tool names; a pattern fails the graph check                                                                                                                                             | `--fork <id>`                  |
| `claude`   | Patterns; a tool it lacks fails the graph check; commit and pull request attribution is off                                                                                                   | `--resume <id> --fork-session` |
| `codex`    | `edit`, `write` and `bash` together give every tool, else a read-only `/work`; some of the three fails the check. Codex's own sandbox stays off, as it needs namespaces the container forbids | `exec resume <id>`             |

Trace-reading agents need a file-reading tool. Every agent prompt receives the news path.

Agent `tools` defaults to none. Session homes under `homes/` in the data folder persist across resumes; a resume finds its home by name there, so a moved data folder keeps them. <!-- code: src/harnesses.ts#harnessSession -->

### Harness versions

The stock Dockerfile pins harness packages with exact version ARGs, enforced by tests. Edit an ARG to update a harness; the next local runner start rebuilds the stock image when its source hash changes. <!-- code: tests/dockerfile-pins.test.ts src/docker.ts#ensureImage -->

`node bin/pins.mjs` lists pins and current npm versions. `node bin/pins.mjs --set OPENCODE_VERSION=1.20.0` updates matching ARGs and requires an exact version. <!-- code: bin/pins.mjs -->

Runs record the Docker ID and installed harness versions probed from the actual image. Failed probes leave versions unknown. Rebuild derived images separately after updating their base. <!-- code: src/docker.ts#readImage src/types.ts#Checkout -->

## Models

### Providers

The CLI [picks a provider](cli.md#picking-a-provider), listed in `agentgraph.config.ts`. <!-- code: harnesses/providers.ts#makeProviders -->

Providers declare readiness, harnesses, settings and optional login. `setup` explains missing configuration; `whyLogin` gives recovery guidance for a rejected login.

A provider can select a direct harness auth mode, such as the bundled ChatGPT mode, or supply a proxy URL, which takes priority. With neither, the harness uses its isolated home configuration rather than the host login.

Login recovery uses the provider recorded on the latest login-related stop; missing provider data gives no provider-specific advice. <!-- code: src/status.ts#findLoginProvider -->

| Provider    | Harness                   | Ready when                                                                                                                               |
| ----------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `claude`    | `claude`                  | its token is in the macOS Keychain or `~/.config/agentgraph/claude-token`, or `CLAUDE_CODE_OAUTH_TOKEN` is set                           |
| `chatgpt`   | `codex`, `opencode`, `pi` | its own login is in `~/.config/agentgraph/codex/auth.json`; offered when `codex login status` passes                                     |
| `anthropic` | `claude`                  | `ANTHROPIC_API_KEY` is set                                                                                                               |
| `litellm`   | any                       | `AGENTGRAPH_PROXY_KEYS` is set; agents without a model get `smart`. ChatGPT comes through here ([local stack](../infra/local/README.md)) |

The Claude provider runs `claude setup-token`, tests the pasted token and stores it only after success.

The ChatGPT provider keeps its own Codex login under `~/.config/agentgraph/codex`. The host refreshes it; sessions receive only the access token, with the refresh token blanked, through each harness's native auth configuration. <!-- code: harnesses/providers.ts#chatgpt harnesses/codex.ts#makeCodexHarness harnesses/opencode.ts#opencode harnesses/pi.ts#pi -->

#### A ChatGPT login in sessions

With the ChatGPT provider, sessions hold an access token that agent code could leak, including in a diff. Known secrets are redacted from output, but diffs are not masked. The refresh token stays on the host. The optional LiteLLM gateway keeps subscription logins outside sessions and gives agents revocable keys.

### Settings

An agent's `model` is the name its endpoint expects. `AGENTGRAPH_MODELS` maps `alias=model` pairs, `*` for agents without a `model`; without one, opencode and pi ask for `default`.

| Setting                  | Meaning                                                                                                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AGENTGRAPH_PROXY_URL`   | One base URL, or `harness=url` pairs. Empty leaves Claude Code on its own login; opencode and pi need one.                                                                                                                                                               |
| `AGENTGRAPH_PROXY_KEYS`  | `agent=key` pairs, `*` for the rest. Without a key, an agent gets `none` when its harness has a URL, else its own login.                                                                                                                                                 |
| `AGENTGRAPH_SESSION_ENV` | Only model login variables: `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `AGENTGRAPH_CHATGPT_AUTH` and `OPENCODE_AUTH_CONTENT`. Tracker and plugin service credentials cannot be forwarded through this setting. Values of 8 or more characters are hidden in output. |

In the container the key is `AGENTGRAPH_LLM_API_KEY` for opencode and pi and `ANTHROPIC_AUTH_TOKEN` for Claude Code, passed by name, never in arguments. Every session is priced at its model's public list price, subscriptions too, so runs compare across providers. The table is LiteLLM's, pinned at `infra/local/prices.json.gz` (`AGENTGRAPH_PRICES` names another), and `infra/local/aliases.json` maps proxy aliases to its models. A model the table lacks is `unpriced`, never $0. Its sessions, checks and runs keep the mark, and their totals show a `+`, as in `$0.42+`: the total leaves out what that model used. <!-- code: src/harnesses.ts#priced src/prices.ts#readPrices src/stats.ts#sumSpend src/trace.ts#formatSpend -->

### Gateways

The optional deployment [gateway relay](hosting.md) forwards to `GATEWAY_URL` and applies `GATEWAY_HEADERS`. This example keeps provider credentials in the relay; paths are preserved. <!-- code: examples/deploy/gateway/forward.ts#forwardToGateway -->

Set relay authorization in `GATEWAY_HEADERS`, or per-agent LiteLLM keys in `AGENTGRAPH_PROXY_KEYS`. Endpoint paths depend on the provider and harness.

Direct Claude subscription access needs `network: egress` and its model login forwarded through `AGENTGRAPH_SESSION_ENV`.

## Secrets on the host

- Only `AGENTGRAPH_APP_KEY`, `AGENTGRAPH_PROXY_KEYS` and the `AGENTGRAPH_SESSION_ENV` names may come from a `_FILE`, read once per start. Bench keys stay in the engine's memory. <!-- code: src/main.ts#readEngineEnv bin/bench.ts#readBenchKeys -->
- Host git, docker and environment builds get only `PATH`, `HOME`, `USER`, `TMPDIR`, the locale, `TZ` and the Docker settings. <!-- code: src/git.ts#makeHostEnv -->
- Keys never show in a process list, and npm runs no install scripts (`ignore-scripts=true`, `min-release-age=7`).
- The studio dev server serves only `studio/`, `src/` and `node_modules/`, and refuses env, key, certificate and `.npmrc` files. <!-- code: studio/vite.config.ts#deny -->
- On macOS the App key stays in the Keychain; see [Running on GitHub](github.md#the-key).

Code running as your user can still read these keys.

`node bin/leak-probe.ts` reports where key-shaped values occur without printing them. It exits 1 for copies to remove or 3 for incomplete probes. `PROBE_PATHS`, `PROBE_STUDIO` and `PROBE_CANARY` control the scan. <!-- code: bin/leak-probe.ts#secret -->

Harness adapters expose only selected engine tools over authenticated Streamable HTTP; the reserved `AGENTGRAPH_TOOL_SECRET` carries the session bearer. <!-- code: src/types.ts#SessionSpec src/types.ts#Command harnesses/claude.ts#claude harnesses/codex.ts#makeCodexHarness harnesses/opencode.ts#opencode harnesses/pi.ts#pi -->

Session output and transcripts share credential redaction before storage. Known values and common credential patterns are hidden; this cannot detect every secret. <!-- code: src/context.ts#formatRedactedText src/harnesses.ts#harnessSession src/services.ts#settings -->

Host tools use a per-session relay on the selected sandbox network. It forwards only the host listener port, holds no bearer and closes with the session. <!-- code: src/docker.ts#dockerRunner src/sandbox.ts#Sandbox src/harnesses.ts#harnessSession -->

For image uploads to host tools, use sandbox `agi file put <path>` and pass its single-use handle. It connects through `AGENTGRAPH_TOOL_URL` with the session bearer. Custom images need that command; runners must support tool transport. See [Plugins](plugins.md). <!-- code: src/files.ts#makeFiles src/tools.ts#startTools infra/local/sandbox/file.ts#runFile src/remote.ts#whyBoxRefused src/mirror.ts#makeSandbox -->
