# Sandbox and models

## The sandbox

Sessions, `run` steps, checks and setup use runners. `local` uses throwaway Docker containers without pulling images. Missing Docker or required networks are engine errors. <!-- code: src/docker.ts#dockerArgs src/remote.ts#boxRunner -->

Containers have read-only roots, your non-root uid, no capabilities, `no-new-privileges`, 512 pids and timeouts. No Docker socket or GitHub token enters them. Sessions receive model credentials and configured tool bearers. <!-- code: src/docker.ts#dockerArgs -->

Step `limits` cover sessions, scripts and checks. Asides use their `back` target's limits. See [resources](reference.md#settingsyaml). <!-- code: src/run/follow.ts#runAside src/types.ts#CommandLimits src/run/attempt.ts#runAttempt src/run/execute.ts#runShell src/run/execute.ts#makeAgentSessionSpec -->

| Path | Contents and access |
| --- | --- |
| `/work` | Checkout; read-only for sessions with only read-only tools |
| `/scratch` | Private writable disk; removed with checkout |
| `/tmp` | Writable memory; 1 GiB charged against memory limit |
| `/home/agent` | Writable session home |
| `/graph` | Read-only `AGENTGRAPH_DIR`; scripts and setup only |
| `/cache` | Repository toolchain overlay |
| `/news` | Read-only news, inputs, traces |
| mirror | Read-only git objects |

<!-- code: src/sandbox.ts#inside src/docker.ts#dockerArgs src/env.ts#getCheckoutPaths src/env.ts#removeCheckout -->

Prompts and file variables use sandbox paths. <!-- code: src/sandbox.ts#inside src/run/attempt.ts#runAttempt -->

Read-only sessions protect git and dependencies. `box` uses a separate user and clears writable processes. <!-- code: src/harnesses.ts#harnessSession src/remote.ts#makeBoxRunner -->

### Runners

The engine owns git, checkouts and publishing. `local` checks Docker, builds stock images and creates networks; `box` uses HTTP at `AGENTGRAPH_SANDBOX_URL`. See [Hosting](hosting.md#cloudflare) and [runner plugins](plugins.md#runners). <!-- code: src/sandbox.ts#Runner src/mirror.ts#makeSandbox src/runners.ts#local src/docker.ts#ensureDockerHost src/services.ts#makeRunner src/runners.ts#box src/remote.ts#boxRunner src/plugin.ts#RunnerHost examples/plugins/modal/modal.ts#makeModalRunner -->

`--runner` or [instance settings](local.md#named-instances-and-settings) select the runner. `agi check` and loops reject unsupported graphs. Runners preserve network and read-only restrictions; `box` refuses custom images, resource overrides and host tools. <!-- code: src/main.ts#readInstanceEnv src/services.ts#hostSettings src/services.ts#whyRunnerRefuses bin/run.ts#loadServedGraph src/remote.ts#whyBoxRefused src/sandbox.ts#Runner -->

## The network

Sessions and setup use the graph's `network`. Scripts and checks have no network. Environment builds use Docker's default network.

| Mode | Docker network | Access |
| --- | --- | --- |
| `egress` | `agentgraph-sandbox` | Model proxy, optional Ollama relay, HTTPS allowlist, selected host tools |
| `models` | `agentgraph-models` | Model proxy, selected host tools |

`infra/local/egress/allowlist` permits GitHub downloads, `registry.npmjs.org` and model logins; excludes PyPI, crates.io, SSH and browsing. Extend it with one extended regex per line in `egress/allowlist` under `AGENTGRAPH_DATA` (normally `~/.agentgraph`). The proxy mounts the folder read-only and merges the allowlist at startup. Reloading preserves connections:

```sh
echo '^api\.example\.com$' >> ~/.agentgraph/egress/allowlist
docker exec agentgraph-egress-1 sh /etc/tinyproxy/start.sh reload
```

`npm run up` names the container `agentgraph-egress-1`; engine startup uses `agentgraph-egress`. `box` uses only the base allowlist. <!-- code: infra/local/egress/start.sh src/docker.ts#ensureDocker -->

`setup` installs dependencies. With `models`, dependencies must already be in the image or environment. Failed setup retries, then parks the run. An answer retries setup and the step. <!-- code: src/run/checkout.ts#runSetup -->

## Environments

Environments cache ignored dependency folders using the base commit's manifests, lockfiles, `setup` and `toolchain`. Bases differing only in source can share an environment; repositories cannot. <!-- code: src/env.ts#readSandboxSetup src/env.ts#readDependencySkeleton src/env.ts#makeSetupVolumeName -->

Checkouts write private overlays. Setup reading `AGENTGRAPH_DIR` runs per checkout. <!-- code: src/env.ts#createSharedMounts src/docker.ts#dockerRunner -->

Runs with only read-only agents skip environments, caches and setup. Their scripts and checks have no installed dependencies. <!-- code: src/folder.ts#loadGraph src/run/drive.ts#runWorkflow src/docker.ts#dockerRunner -->

`AGENTGRAPH_STATE` (`~/.cache/agentgraph`) holds heartbeats and build locks. Hosts sharing Docker must share it. <!-- code: src/owner.ts#readStateDir src/owner.ts#waitForLock src/owner.ts#isOwnerRunning -->

### Disk

`bin/env.ts` manages cached environments. Collection preserves live-process holds (`AGENTGRAPH_ENV_HOLD_HOURS`, default 2 hours), pins and layers needed by retained environments. It removes least recently used data to meet `AGENTGRAPH_ENV_CAP` (60g). <!-- code: src/disk.ts#collect -->

```sh
node bin/env.ts list [--root <dir>]...
node bin/env.ts collect [--cap 60g] [--root <dir>]... [--dry-run]
node bin/env.ts pin <name> <glob>... [--days 14]
node bin/env.ts unpin <name>
node bin/env.ts sweep
```

Before setup builds, free space below `AGENTGRAPH_MIN_FREE_GB` (40 GB) triggers collection using only references recorded in the instance or case. The current image is protected. If space remains insufficient, one `disk low` warning reports free space and the minimum; work continues. `AGENTGRAPH_DISK_LOW=block` makes work wait; `AGENTGRAPH_MIN_FREE_GB=0` disables checking. Global collection is explicit. `sweep` removes dead processes' orphaned volumes. <!-- code: src/disk.ts#ensureFreeDisk src/env.ts#removeOrphanedVolumes -->

### Toolchains

`/cache` reuses downloads by repository, image ID and `toolchain` commands. Trusted builds write under a lock. Untrusted builds and builds overlapping active checkouts use private overlays. Failed installation is an engine error. `AGENTGRAPH_CACHE_VOLUME` sets the prefix; an empty value disables caches and environments. Image or toolchain changes create another cache; [collection](#disk) removes old ones. <!-- code: src/env.ts#makeToolchainSetupCommands src/env.ts#readSandboxSetup src/env.ts#makeLayerVolumeName src/env.ts#written src/services.ts#settings -->

## A graph's own image

Graph `image` selects the command and environment image; [instance settings](local.md#named-instances-and-settings) can override it. Custom images must include harnesses and `agi`, and execute commands directly.

The local runner pins each checkout's image ID, even without caches. Missing stock images build from `infra/local/sandbox`; missing custom tags or unreachable Docker fail visibly. <!-- code: src/docker.ts#readImage src/docker.ts#ensureImage -->

Bench uses the same resolver. <!-- code: src/docker.ts#readImage -->

```sh
docker build -t agentgraph-sandbox:node22 infra/local/sandbox/node22
infra/local/sandbox/smoke.sh agentgraph-sandbox:node22
```

Select it with `image: agentgraph-sandbox:node22`.

### A browser

Build headless Chromium with the repository's Playwright version:

```sh
docker build -t agentgraph-sandbox:browser --build-arg PLAYWRIGHT_VERSION=1.60.0 infra/local/sandbox/browser
```

Set `image: agentgraph-sandbox:browser`. The image provides Playwright's browser path and disables browser downloads.

## Harnesses

Operator-configured `harness` entries supply packages, commands, parsers, tool classifications, optional home files and validation. Unknown tools fail validation. Sessions with only read-only tools receive read-only checkouts. <!-- code: src/harnesses.ts#Harness src/harnesses.ts#readHarnessSettings -->

`AGENTGRAPH_PROVIDER` and `AGENTGRAPH_HARNESS` override defaults. A selected harness overrides agent choices. Otherwise, the default is the provider's first harness, then the config's first. Used harnesses must be configured and valid. <!-- code: src/folder.ts#loadGraph -->

| Harness | Permissions | Aside fork |
| --- | --- | --- |
| `opencode` | Patterns: `bash(git diff*)` | `--session <id> --fork` |
| `pi` | Names; patterns fail | `--fork <id>` |
| `claude` | Patterns; unavailable tools fail validation; commit and pull request attribution is off | `--resume <id> --fork-session` |
| `codex` | Granting `edit`, `write` and `bash` together enables every tool. Granting only some fails validation; granting none makes `/work` read-only. Codex's sandbox is off because the container forbids required namespaces | `exec resume <id>` |

Trace-reading agents need file-reading tools. Sessions find their saved homes by name under `homes/`, including after a data-folder move. <!-- code: src/harnesses.ts#harnessSession -->

### Harness versions

Tests enforce exact Dockerfile ARG pins; source-hash changes rebuild stock images at local startup. <!-- code: tests/dockerfile-pins.test.ts src/docker.ts#ensureImage -->

`node bin/pins.mjs` lists pins and current npm versions. `node bin/pins.mjs --set OPENCODE_VERSION=1.20.0` updates matching ARGs and requires an exact version. Rebuild derived images separately. <!-- code: bin/pins.mjs -->

## Models

### Providers

[CLI selection](cli.md#picking-a-provider) uses `agentgraph.config.ts` providers. <!-- code: harnesses/providers.ts#makeProviders -->

Providers declare readiness, harnesses, settings and optional login. `setup` explains missing configuration; `whyLogin` explains recovery from rejected logins. A proxy URL overrides direct harness auth. With neither configured, the harness uses its isolated home configuration.

Login recovery uses the provider recorded on the latest login-related stop. Missing provider data gives no provider-specific advice. <!-- code: src/status.ts#findLoginProvider -->

| Provider | Harnesses | Readiness |
| --- | --- | --- |
| `claude` | `claude` | Keychain, `~/.config/agentgraph/claude-token` or `CLAUDE_CODE_OAUTH_TOKEN` |
| `chatgpt` | `codex`, `opencode`, `pi` | `~/.config/agentgraph/codex/auth.json`; `codex login status` passes |
| `anthropic` | `claude` | `ANTHROPIC_API_KEY` |
| `litellm` | Any | `AGENTGRAPH_PROXY_KEYS`; unspecified models use `smart`; [ChatGPT stack](../infra/local/README.md) |

[Claude login](local.md#models) tests the pasted token before storage. The host refreshes the ChatGPT login. Sessions receive its access token through native harness auth, with the refresh token blanked. <!-- code: harnesses/providers.ts#chatgpt harnesses/codex.ts#makeCodexHarness harnesses/opencode.ts#opencode harnesses/pi.ts#pi -->

#### A ChatGPT login in sessions

Agent code can leak access tokens, including through unmasked diffs. LiteLLM instead supplies revocable keys while retaining subscription logins outside sessions.

### Settings

An agent's `model` names the model its endpoint expects. `AGENTGRAPH_MODELS` maps `alias=model` pairs; `*` covers agents without a model. Without a mapping, `opencode` and `pi` request `default`.

| Setting | Meaning |
| --- | --- |
| `AGENTGRAPH_PROXY_URL` | URL or `harness=url`; empty uses Claude login; `opencode`/`pi` need a URL |
| `AGENTGRAPH_PROXY_KEYS` | `agent=key`; `*` covers others. Missing key gives `none` with URL, otherwise login |
| `AGENTGRAPH_SESSION_ENV` | Only `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `AGENTGRAPH_CHATGPT_AUTH`, `OPENCODE_AUTH_CONTENT`; no tracker/plugin credentials. Values at least eight characters are redacted |

Keys use `AGENTGRAPH_LLM_API_KEY` (`opencode`/`pi`) or `ANTHROPIC_AUTH_TOKEN` (`claude`), never arguments. Public-list pricing includes subscriptions. `AGENTGRAPH_PRICES` overrides `infra/local/prices.json.gz`; `infra/local/aliases.json` resolves aliases. Reported models take precedence. Missing prices mark sessions, checks and runs `unpriced`. Totals omit unpriced usage and show `+`. <!-- code: src/harnesses.ts#priced src/prices.ts#readPrices src/stats.ts#sumSpend src/trace.ts#formatSpend -->

### Gateways

The [relay](hosting.md) forwards to `GATEWAY_URL`, preserving paths and applying `GATEWAY_HEADERS`. <!-- code: examples/deploy/gateway/forward.ts#forwardToGateway -->

Set relay authorization in `GATEWAY_HEADERS`, or per-agent keys in `AGENTGRAPH_PROXY_KEYS`. Paths depend on the provider and harness. Direct Claude subscription access needs `network: egress` and its login forwarded through `AGENTGRAPH_SESSION_ENV`.

## Secrets on the host

Only `AGENTGRAPH_APP_KEY`, `AGENTGRAPH_PROXY_KEYS` and `AGENTGRAPH_SESSION_ENV` names accept `_FILE` sources, including `AGENTGRAPH_APP_KEY_FILE`, read once per start. <!-- code: src/main.ts#readEngineEnv -->

Bench keys stay in the engine's memory. <!-- code: bin/bench.ts#readBenchKeys -->

Host git, Docker and environment builds receive only `PATH`, `HOME`, `USER`, `TMPDIR`, locale, `TZ` and Docker settings. <!-- code: src/git.ts#makeHostEnv -->

Keys stay out of process lists; npm uses `ignore-scripts=true` and `min-release-age=7`. Code running as your user can read keys. [App storage](github.md#the-key) uses macOS Keychain.

The studio dev server serves only `studio/`, `src/` and `node_modules/`. It refuses environment, key, certificate and `.npmrc` files. <!-- code: studio/vite.config.ts#deny -->

`node bin/leak-probe.ts` reports secret locations without printing values. It exits 1 for copies to remove or 3 for incomplete scans. `PROBE_PATHS`, `PROBE_STUDIO` and `PROBE_CANARY` control the scan. <!-- code: bin/leak-probe.ts#secret -->

Selected tools use authenticated Streamable HTTP; `AGENTGRAPH_TOOL_SECRET` holds the reserved session bearer. <!-- code: src/types.ts#SessionSpec src/types.ts#Command harnesses/claude.ts#claude harnesses/codex.ts#makeCodexHarness harnesses/opencode.ts#opencode harnesses/pi.ts#pi -->

Session output and transcripts redact known credentials and common credential patterns before storage. This cannot detect every secret. <!-- code: src/context.ts#formatRedactedText src/harnesses.ts#harnessSession src/services.ts#settings -->

Per-session network relays forward one host-listener port, hold no bearer and close with sessions. <!-- code: src/docker.ts#dockerRunner src/sandbox.ts#Sandbox src/harnesses.ts#harnessSession -->

Uploads connect to `AGENTGRAPH_TOOL_URL` using the session bearer. See [uploads](plugins.md) for commands and runner requirements. <!-- code: src/tools.ts#startTools infra/local/sandbox/file.ts#runFile src/remote.ts#whyBoxRefused src/mirror.ts#makeSandbox -->
