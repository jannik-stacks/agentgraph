# Sandbox and models

How a run is isolated and which models it can reach.

## The sandbox

Every session, script step, check script and setup is one `docker run --rm`. Nothing runs on the host. When docker or the `bothub-sandbox` network is not usable, the run stops with the reason.

Each container has:

- a read-only root filesystem and `/tmp` as a tmpfs,
- the operator's own non-root user, all capabilities dropped and `no-new-privileges`,
- 4g memory, 1.5 CPUs and 512 pids,
- the toolchain volume at `/cache`, see [Toolchains](#toolchains),
- no image pulls,
- a watchdog that kills it at the timeout.

The checkout is at `/work` and the session's home at `/home/agent`, both writable. The hub is at `/hub`, read-only, and named by `BOTHUB_HUB`. The bare mirror is mounted read-only, so refs and objects cannot be touched. <!-- code: src/docker.ts#dockerArgs -->

The docker socket is never mounted and no GitHub token goes inside. A session gets the proxy URL and its own agent's key. Pushes and pull requests happen on the host, after the checks pass.

## The network

Sessions and the hub's `setup` join `bothub-sandbox`, an internal docker network. Its only ways out are:

- the model proxy,
- the Ollama relay to the host's Ollama, when the `sandbox` compose profile runs it,
- the egress proxy, which allows HTTPS to the hosts in `infra/local/egress/allowlist` and nothing else: `github.com`, `codeload.github.com`, `objects.githubusercontent.com` and `registry.npmjs.org`.

That allows `npm install` from the npm registry and cloning or downloading from GitHub over HTTPS. It does not allow other package registries (PyPI, crates.io, Docker Hub), SSH, general web browsing or web search.

Scripts and checks run with no network at all.

With `network: models` in `hub.yaml`, sessions and setup join `bothub-models` instead. Only the model proxy is on that network, so nothing else can be reached, not even the npm registry. Dependencies then come from the hub's image. The local compose stack creates the network and puts the proxy on it.

`setup` in `hub.yaml` is a shell script that installs dependencies, for example `npm ci --prefix kit --no-audit --no-fund`. It runs once per base commit in the hub's [environment](#environments), and again in a checkout whose files differ from the base. A setup that fails parks the run, and an answer runs setup and the step again.

The image is built from `infra/local/sandbox`. `smoke.sh` there checks it the way a run uses it.

## Environments

A run should not install its dependencies again for every checkout. bothub builds a repo's environment once per base commit and starts every checkout and score from it, the way a Docker build caches layers and CI caches dependencies.

The environment is a local image, `bothub-env/<repo>:<key>`. One build container makes it:

1. It unpacks the files of the base commit into `/work`, from the read-only mirror. Nothing a run wrote is there.
2. It runs the [toolchain step](#toolchains).
3. It runs the hub's `setup`.
4. It lists the ignored directories setup made, such as `node_modules` or `target`, and commits the container as the image.

The build has docker's default network, so it reaches any host. The key covers the base image, the base commit's files, the toolchain lines and `setup`, so an image with the same key is never built again. A setup that reads `$BOTHUB_HUB` is left out of the build and runs in each checkout. <!-- code: src/env.ts#envOf -->

Each checkout gets a new docker volume for every `node_modules` or `target` directory setup made, mounted at the same path under `/work`. One short container copies the image's files into these volumes, so the checkout starts with its dependencies installed. These copies live on docker's disk, not in the checkout folder on the host. Smaller outputs, such as a `dist` or a wasm `pkg`, are copied into the checkout folder itself, because a build may delete and remake them and a mount point cannot be deleted. What a run writes to them stays in that checkout, and the volumes are removed with it. A checkout of the base's own files skips setup. Setup runs again on a checkout with other files, such as a resumed run, and on one whose setup also left files outside those directories.

The volumes carry the process that made them, and a runner that starts removes the ones whose process is gone. Images pile up, one per base. To remove the ones unused for 14 days, run `node bin/env.ts prune --days 14`. `list` shows them with their last use and `--dry` only names them. Docker keeps an image that a container still uses.

`BOTHUB_IMAGE` names the image a build starts from when a hub sets no `image`. The default is `bothub-sandbox:local`.

### Toolchains

The image carries toolchain managers and a C compiler, not toolchains. Every container mounts the docker volume `bothub-cache` at `/cache`. rustup and cargo keep their homes there, and npm, pnpm and yarn keep their downloads there, so what one run fetched serves every later run, check and data dir. Each of these tools but yarn 1 locks its own writes, so parallel runs do not corrupt the volume.

The toolchain step installs what the repo's root files name:

| Files                                                   | Installs                                                                     |
| ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `Cargo.toml`, `rust-toolchain` or `rust-toolchain.toml` | The pinned toolchain, or stable, with clippy and rustfmt, then `cargo fetch` |

Then it runs the hub's `toolchain` script, for what the repo files do not name, such as a target or a cargo subcommand:

```yaml
toolchain: rustup target add wasm32-unknown-unknown && cargo install --locked cargo-nextest
```

A failed toolchain step stops the run with its output. A lock file in the volume lets one build at a time install, so two runners never race inside rustup. On a warm volume the step takes seconds, because rustup and cargo find everything already installed. Checks then build offline from the fetched crates. <!-- code: src/env.ts#toolchainOf -->

`BOTHUB_CACHE_VOLUME` names another volume. An empty value turns off the volume and the environments. Every run can write to the volume, so treat it like the egress network: a run could leave files there that later runs use. `docker volume rm bothub-cache` empties it.

## A hub's own image

`image` in `hub.yaml` names a local image that every command of a run starts in: sessions, setup, scripts and checks. The [environment](#environments) builds on top of it. bothub never builds or pulls it. Build it beforehand from the sandbox image, so the harnesses are already in it, and add what the repo needs, such as a toolchain or installed dependencies:

```dockerfile
FROM bothub-sandbox:local
USER root
COPY package.json package-lock.json /
RUN npm ci --no-audit --no-fund && npm cache clean --force
ENV PATH=/node_modules/.bin:$PATH
USER node
```

Node looks for packages in every parent folder, so `/node_modules` from the image serves the checkout at `/work` with no install. The dependencies are the ones locked when the image was built, and a pull request that changes them does not change the image.

```yaml
image: acme-node:bothub
network: models
```

Tests use a host sandbox that runs commands directly in a clone, with no network rules. <!-- code: src/sandbox.ts#host -->

## Harnesses

An agent's `harness` picks the program that runs its session.

| Harness    | Notes                                                                                |
| ---------- | ------------------------------------------------------------------------------------ |
| `opencode` | Real tool allowlists, including patterned bash like `bash(git diff*)`                |
| `pi`       | Plain tool names only; patterned entries are dropped, so use it for read-only agents |
| `claude`   | Claude Code on the model proxy's Anthropic endpoint, with patterned tools            |

`tools` in the agent file lists the tools a session may use. It defaults to none. A bash pattern also allows the same command behind `NODE_OPTIONS= command `, the prefix some repos ask for.

Each harness is a small adapter. It builds the command and turns the harness's output into the same session events. Each session gets its own home under `homes/` in the data dir, reused when it resumes. An [aside](loop.md#asides) forks a session in a copy of its home: opencode with `--session <id> --fork`, Claude Code with `--resume <id> --fork-session`, pi with `--fork <id>`. The session it forks stays as it was. <!-- code: src/harnesses.ts#harnesses -->

## Models

An agent names a model alias with `model`, never a vendor model. Without one, opencode and pi use the alias `default` and Claude Code uses its own default.

LiteLLM sits in front of every model and maps aliases to upstreams. It gives each agent its own virtual key, so the logs show which agent spent what.

`BOTHUB_PROXY_URL` points at the proxy. `BOTHUB_PROXY_KEYS` lists `name=key` pairs, one per agent, separated by commas or spaces. An agent without a key cannot start a session. <!-- code: src/harnesses.ts#keysOf -->

Inside the container the key is `BOTHUB_LLM_API_KEY` for opencode and pi, and `ANTHROPIC_AUTH_TOKEN` for Claude Code. opencode finds the proxy at `BOTHUB_LLM_BASE_URL`. The key is passed by name, never on a command line, and masked in the harness output.

Usage a harness does not price, as with a subscription behind the proxy, is priced from the list prices in `infra/local/prices.json`, or the file `BOTHUB_PRICES` names. <!-- code: src/harnesses.ts#priced -->

Moving an alias from an API key to a subscription is a proxy config change. No agent file changes.

Aliases and routes are in `infra/local/litellm.config.yaml`.
