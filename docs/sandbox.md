# Sandbox and models

## Runners

A runner executes commands in the checkout the engine prepares. Sessions, script steps, checks and setup all use it. The `local` runner builds stock images, creates the Docker networks and runs a temporary container per command. The `box` runner executes commands on a remote machine over HTTP at `AGENTGRAPH_SANDBOX_URL`. See [hosting a box](hosting.md#cloudflare) and [runner plugins](plugins.md#runners). <!-- code: src/sandbox.ts#Runner src/mirror.ts#makeSandbox src/docker.ts#dockerRunner src/docker.ts#ensureDockerHost src/remote.ts#boxRunner -->

Select a runner with `--runner` or the [instance settings](local.md#named-instances-and-settings). Graph validation and the loop report settings the selected runner cannot enforce. For example, `box` refuses custom images, memory and CPU overrides, and plugin tools that need to call the host. <!-- code: src/main.ts#readInstanceEnv src/services.ts#whyRunnerRefuses bin/run.ts#loadServedGraph src/remote.ts#whyBoxRefused -->

## The sandbox

Local containers run as your non-root user with a read-only root filesystem, all capabilities dropped, `no-new-privileges`, a limit of 512 processes and a timeout. The engine keeps the Docker socket and tracker credentials on the host. A session receives its model credentials and a token for the plugin tools it may call. <!-- code: src/docker.ts#dockerArgs src/harnesses.ts#harnessSession src/tools.ts#startTools -->

Step `limits` apply to sessions, scripts and checks. An [aside](index.md#terms) uses the limits of its `back` target. See [resource limits](reference.md#settingsyaml). <!-- code: src/run/follow.ts#runAside src/types.ts#CommandLimits src/run/execute.ts#runShell src/run/execute.ts#makeAgentSessionSpec -->

| Path | Contents and access |
| --- | --- |
| `/work` | The checkout is read-only for sessions granted only read-only tools. |
| `/scratch` | Private writable space that the engine removes with the checkout |
| `/tmp` | Up to 1 GiB of writable space charged against the memory limit |
| `/home/agent` | Writable session home |
| `/graph` | Read-only graph folder, available as `AGENTGRAPH_DIR` inside sandbox scripts and setup |
| `/cache` | Repository toolchain overlay |
| `/news` | Read-only issue updates, inputs and traces |
| Git mirror | Read-only Git objects shared between checkouts |

<!-- code: src/sandbox.ts#inside src/docker.ts#dockerArgs src/env.ts#getCheckoutPaths src/env.ts#removeCheckout src/harnesses.ts#harnessSession -->

Prompts and file variables use sandbox paths. The Cloudflare box runs read-only commands as a separate user and clears processes left by writable commands. <!-- code: src/sandbox.ts#inside src/run/attempt.ts#runAttempt examples/deploy/cloudflare/box.sh -->

## The network

Sessions and setup use the graph's `network`. Scripts and checks have no network. Environment builds use Docker's default network. <!-- code: src/docker.ts#dockerArgs src/docker.ts#dockerRunner src/run/checkout.ts#runSetup src/run/execute.ts#runShell -->

| Mode | Docker network | Access |
| --- | --- | --- |
| `egress` | `agentgraph-sandbox` | Model proxy, optional Ollama relay, HTTPS allowlist, selected plugin tools on the host |
| `models` | `agentgraph-models` | Model proxy, selected plugin tools on the host |

<!-- code: src/docker.ts#dockerArgs src/docker.ts#networks infra/local/docker-compose.yml -->

The egress proxy's built-in allowlist permits GitHub downloads, the npm registry and model logins. To allow another HTTPS host, add an extended regular expression on its own line. The proxy merges the additions with the built-in list at startup or reload. The Cloudflare box uses the built-in list. <!-- code: infra/local/egress/allowlist infra/local/egress/start.sh examples/deploy/cloudflare/worker.ts -->

When the engine creates `agentgraph-egress`, it mounts the creating instance's `data/egress/` folder read-only. Later instances share that container. With the default data root, edit `~/.agentgraph/<name>/data/egress/allowlist`. Reload that container to apply the change. <!-- code: src/docker.ts#ensureDockerHost src/main.ts#readInstanceEnv src/services.ts#hostSettings infra/local/egress/start.sh -->

```sh
docker exec agentgraph-egress sh /etc/tinyproxy/start.sh reload
```

The Compose stack started by `npm run up` uses a different mount. Its container is `agentgraph-egress-1` and its allowlist is under the shell's `AGENTGRAPH_DATA`, normally `~/.agentgraph/egress/allowlist`. For example, allow one host and reload the Compose container. <!-- code: infra/local/docker-compose.yml package.json infra/local/egress/start.sh -->

```sh
echo '^api\.example\.com$' >> ~/.agentgraph/egress/allowlist
docker exec agentgraph-egress-1 sh /etc/tinyproxy/start.sh reload
```

The graph's `setup` command installs dependencies. With `network: models`, dependencies must already be in the image or environment. See [engine errors](workflows.md#engine-errors) for recovery after setup fails. <!-- code: src/run/checkout.ts#runSetup src/run/drive.ts#runWorkflow -->

## Environments

Environments cache ignored dependency folders using the base commit's manifests, lockfiles, `setup` and `toolchain`. Base commits in the same repository can share an environment when only the source changes. <!-- code: src/env.ts#readSandboxSetup src/env.ts#readDependencySkeleton src/env.ts#makeSetupVolumeName -->

Checkouts write private overlays. A setup command that reads the sandbox graph folder through `AGENTGRAPH_DIR` runs once per checkout. <!-- code: src/env.ts#createSharedMounts src/docker.ts#dockerRunner -->

Runs with only read-only agents skip environments, caches and setup. Their scripts and checks have no installed dependencies. <!-- code: src/folder.ts#loadGraph src/run/drive.ts#runWorkflow src/docker.ts#dockerRunner -->

`AGENTGRAPH_STATE` (`~/.cache/agentgraph`) holds heartbeats and build locks. Hosts that share Docker must share this folder. <!-- code: src/owner.ts#readStateDir src/owner.ts#waitForLock src/owner.ts#isOwnerRunning -->

### Disk

`bin/env.ts` manages cached environments. Collection preserves live-process holds (`AGENTGRAPH_ENV_HOLD_HOURS`, default 2 hours), pins and layers needed by retained environments. It removes least recently used data to meet `AGENTGRAPH_ENV_CAP` (60g). <!-- code: src/disk.ts#collect -->

```sh
node bin/env.ts list [--root <dir>]...
node bin/env.ts collect [--cap 60g] [--root <dir>]... [--dry-run]
node bin/env.ts pin <name> <glob>... [--days 14]
node bin/env.ts unpin <name>
node bin/env.ts sweep
```

Before a setup build, the engine checks for `AGENTGRAPH_MIN_FREE_GB` of free space (default 40 GB). Below that threshold it cleans up using the instance or case records and protects the current image. If space is still low, the engine reports the available and required space and continues. Set `AGENTGRAPH_DISK_LOW=block` to make work wait or `AGENTGRAPH_MIN_FREE_GB=0` to disable the check. Use `sweep` to remove volumes left by dead processes. <!-- code: src/disk.ts#ensureFreeDisk src/env.ts#removeOrphanedVolumes -->

### Toolchains

`/cache` reuses downloads by repository, image ID and `toolchain` commands. Trusted builds write under a lock. Untrusted builds and builds overlapping active checkouts use private overlays. Failed installation is an engine error. `AGENTGRAPH_CACHE_VOLUME` sets the volume prefix. An empty value disables caches and environments. Image or toolchain changes create another cache. [Collection](#disk) removes old ones. <!-- code: src/env.ts#makeToolchainSetupCommands src/env.ts#readSandboxSetup src/env.ts#makeLayerVolumeName src/env.ts#written src/services.ts#settings -->

## A graph's own image

The graph's `image` selects the image for commands and dependency environments. [Instance settings](local.md#named-instances-and-settings) can override it. A custom image must contain the selected harnesses and `agi` and execute commands directly. <!-- code: src/settings.ts#getSettings src/docker.ts#dockerArgs src/docker.ts#dockerRunner -->

The local runner pins each checkout's image ID, even without caches. The engine builds missing stock images from `infra/local/sandbox`. It reports an error if a custom image is missing or Docker is unreachable. <!-- code: src/docker.ts#readImage src/docker.ts#ensureImage -->

Bench uses the same resolver. <!-- code: src/docker.ts#readImage -->

```sh
docker build -t agentgraph-sandbox:node22 infra/local/sandbox/node22
infra/local/sandbox/smoke.sh agentgraph-sandbox:node22
```

Select it with `image: agentgraph-sandbox:node22`. <!-- code: infra/local/sandbox/node22/Dockerfile src/folder.ts#GraphSettings -->

### A browser

Build headless Chromium with the repository's Playwright version. <!-- code: infra/local/sandbox/browser/Dockerfile -->

```sh
docker build -t agentgraph-sandbox:browser --build-arg PLAYWRIGHT_VERSION=1.60.0 infra/local/sandbox/browser
```

Set `image: agentgraph-sandbox:browser`. The image provides Playwright's browser path and disables browser downloads. <!-- code: infra/local/sandbox/browser/Dockerfile -->

## Harnesses

A harness launches the agent session and interprets its output. Set `AGENTGRAPH_CONFIG` to choose the harness configuration file. When it is unset, the engine loads `<data root>/config.ts` if it exists, then falls back to the bundled `agentgraph.config.ts`. The entries describe commands, parsers, tool permissions, optional home files and validation. Unknown tools fail validation. <!-- code: src/harnesses.ts#Harness src/harnesses.ts#readHarnessSettings src/services.ts#readHostSettings src/main.ts#readInstanceEnv -->

`AGENTGRAPH_PROVIDER` and `AGENTGRAPH_HARNESS` override defaults. A selected harness overrides agent choices. Otherwise, the default is the provider's first harness, then the config's first. Used harnesses must be configured and valid. <!-- code: src/folder.ts#loadGraph -->

| Harness | Permissions | Aside fork |
| --- | --- | --- |
| `opencode` | Tool patterns such as `bash(git diff*)` | `--session <id> --fork` |
| `pi` | Tool names only | `--fork <id>` |
| `claude` | Tool patterns. Unavailable tools fail validation. Commit and pull request attribution is off. | `--resume <id> --fork-session` |
| `codex` | Grant all three write tools (`edit`, `write`, `bash`) or none. Granting all three enables every tool. The container handles isolation. | `exec resume <id>` |

<!-- code: harnesses/opencode.ts#opencode harnesses/pi.ts#pi harnesses/claude.ts#claude harnesses/codex.ts#makeCodexHarness -->

Trace-reading agents need file-reading tools. Sessions find their saved homes by name under `homes/`, including after a data-folder move. <!-- code: src/harnesses.ts#harnessSession -->

### Harness versions

Tests require exact versions in Dockerfile build arguments. A local startup rebuilds stock images when the image sources change. <!-- code: tests/dockerfile-pins.test.ts src/docker.ts#ensureImage -->

`node bin/pins.mjs` lists pins and current npm versions. `node bin/pins.mjs --set OPENCODE_VERSION=1.20.0` updates matching ARGs and requires an exact version. Rebuild derived images separately. <!-- code: bin/pins.mjs -->

## Models

### Providers

A provider supplies the login or key a harness uses to reach the model. The [CLI](cli.md#picking-a-provider) selects from the configured providers. <!-- code: harnesses/providers.ts#makeProviders -->

Providers declare how to check readiness, which harnesses they support and how to configure them. A provider can also start a login. Its `setup` text explains missing configuration and `whyLogin` explains how to recover from a rejected login. A proxy URL overrides direct harness auth. With neither configured, the harness uses its isolated home configuration. <!-- code: src/harnesses.ts#Provider src/harnesses.ts#harnessSession harnesses/providers.ts#makeProviders -->

Login recovery uses the provider recorded on the latest login-related stop. Missing provider data gives no provider-specific advice. <!-- code: src/status.ts#findLoginProvider -->

| Provider | Harnesses | Readiness |
| --- | --- | --- |
| `claude` | `claude` | Keychain, `~/.config/agentgraph/claude-token` or `CLAUDE_CODE_OAUTH_TOKEN` |
| `chatgpt` | `codex`, `opencode`, `pi` | `~/.config/agentgraph/codex/auth.json`; `codex login status` passes |
| `anthropic` | `claude` | `ANTHROPIC_API_KEY` |
| `litellm` | Any | `AGENTGRAPH_PROXY_KEYS`; unspecified models use `smart`; [ChatGPT stack](../infra/local/README.md) |

<!-- code: harnesses/providers.ts#makeProviders -->

When you need to log in, the Claude provider runs `claude setup-token` and tests the pasted token before saving it. The ChatGPT provider starts `codex login` and the host refreshes its login. Sessions receive the ChatGPT access token through the harness with the refresh token blanked. <!-- code: harnesses/providers.ts#claude harnesses/providers.ts#chatgpt harnesses/codex.ts#makeCodexHarness harnesses/opencode.ts#opencode harnesses/pi.ts#pi -->

#### A ChatGPT login in sessions

Agent code can leak access tokens, including through unmasked diffs. LiteLLM instead supplies revocable keys while retaining subscription logins outside sessions. <!-- code: harnesses/providers.ts#litellm harnesses/providers.ts#chatgpt -->

### Settings

An agent's `model` names the model its endpoint expects. `AGENTGRAPH_MODELS` maps aliases to model names with `alias=model` pairs. The `*` entry covers agents without a model. Without a mapping, `opencode` and `pi` request `default`. <!-- code: src/harnesses.ts#harnessSession harnesses/opencode.ts#opencode harnesses/pi.ts#pi -->

| Setting | Meaning |
| --- | --- |
| `AGENTGRAPH_PROXY_URL` | Set a URL for all harnesses or use `harness=url` per harness. An empty URL selects direct login where supported. |
| `AGENTGRAPH_PROXY_KEYS` | Assign keys with `agent=key`. A `*` entry covers other agents. Without a key, a session with a proxy URL uses `none`. |
| `AGENTGRAPH_SESSION_ENV` | Select which of `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `AGENTGRAPH_CHATGPT_AUTH` and `OPENCODE_AUTH_CONTENT` sessions receive. The engine redacts selected values at least eight characters long. |

<!-- code: src/services.ts#settings src/harnesses.ts#harnessSession src/harnesses.ts#parseModelUrls -->

Harnesses receive proxy keys through the environment. Codex, opencode and pi use `AGENTGRAPH_LLM_API_KEY`. Claude Code uses `ANTHROPIC_AUTH_TOKEN`. The engine prices usage at public list prices, including subscription use. Set `AGENTGRAPH_PRICES` to override `infra/local/prices.json.gz`. Aliases come from `infra/local/aliases.json`. A reported model takes precedence when pricing a session. If a price is missing, sessions, checks and runs show `unpriced`, and totals show `+` after the known amount. <!-- code: harnesses/codex.ts#makeCodexHarness harnesses/claude.ts#claude harnesses/pi.ts#pi harnesses/opencode.ts#opencode src/harnesses.ts#priced src/prices.ts#readPrices src/stats.ts#sumSpend src/trace.ts#formatSpend -->

### Gateways

A model gateway forwards requests from sessions to a model service. The default `AGENTGRAPH_PROXY_URL` is `http://gateway:4000/v1`. The [deployment gateway](hosting.md) forwards the request path and query to `GATEWAY_URL` and applies the header values in `GATEWAY_HEADERS`. <!-- code: src/services.ts#proxyUrl examples/deploy/gateway/forward.ts#forwardToGateway -->

Set gateway authorization in `GATEWAY_HEADERS` or supply per-agent keys in `AGENTGRAPH_PROXY_KEYS`. Direct Claude subscription access needs `network: egress` and its login forwarded through `AGENTGRAPH_SESSION_ENV`. <!-- code: examples/deploy/gateway/forward.ts#forwardToGateway harnesses/providers.ts#claude src/services.ts#settings -->

## Secrets on the host

The engine reads secrets from files for `AGENTGRAPH_APP_KEY`, `AGENTGRAPH_PROXY_KEYS` and the variables named in `AGENTGRAPH_SESSION_ENV`. Append `_FILE` to the secret's name and set it to the file path, as in `AGENTGRAPH_APP_KEY_FILE`. A loop rereads its env files and file-based secrets between passes. If the refresh fails, it reports the error and keeps the last settings. <!-- code: src/main.ts#readEngineEnv src/main.ts#readInstanceEnv bin/run.ts#serveLocked -->

Bench keys stay in the engine's memory. <!-- code: bin/bench.ts#readBenchKeys -->

Host commands inherit a limited environment. It includes `PATH`, `HOME`, `USER`, `TMPDIR`, locale, `TZ`, certificate paths and Docker settings. <!-- code: src/git.ts#makeHostEnv -->

Code running as your user can read your keys. The repository configures npm with `ignore-scripts=true` and `min-release-age=7`. On macOS, the App setup can keep its key in the [Keychain](github.md#the-key). <!-- code: .npmrc bin/setup-app.ts#saveKeyInKeychain -->

The studio dev server allows files under `studio/`, `src/`, `bench/` and the repository's `node_modules/`. Its deny list covers `.env`, `.env.*`, `*.env`, `*.{crt,pem,key,p12,pfx,cer,der}`, `.npmrc`, `.yarnrc.yml` and `**/.git/**`. <!-- code: studio/vite.config.ts#allow studio/vite.config.ts#deny -->

`node bin/leak-probe.ts` reports secret locations without printing values. It exits 1 for copies to remove or 3 for incomplete scans. `PROBE_PATHS`, `PROBE_STUDIO` and `PROBE_CANARY` control the scan. <!-- code: bin/leak-probe.ts#secret -->

Selected plugin tools use authenticated Streamable HTTP. The session sends the token in `AGENTGRAPH_TOOL_SECRET` to authenticate each call. <!-- code: src/types.ts#SessionSpec src/types.ts#Command harnesses/claude.ts#claude harnesses/codex.ts#makeCodexHarness harnesses/opencode.ts#opencode harnesses/pi.ts#pi -->

Session output and transcripts redact known credentials and common credential patterns before storage. This cannot detect every secret. <!-- code: src/context.ts#formatRedactedText src/harnesses.ts#harnessSession src/services.ts#settings -->

Each session has a relay that forwards one port to the tool server on the host. The relay requires no copy of the session token and closes when the session ends. <!-- code: src/docker.ts#dockerRunner src/sandbox.ts#Sandbox src/harnesses.ts#harnessSession -->

Uploads connect to `AGENTGRAPH_TOOL_URL` using the session token. See [uploads](plugins.md#uploads) for commands and runner requirements. <!-- code: src/tools.ts#startTools infra/local/sandbox/file.ts#runFile src/remote.ts#whyBoxRefused src/mirror.ts#makeSandbox -->
