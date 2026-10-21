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

`setup` in `hub.yaml` is a shell script that runs once in each new checkout, before the first step. Use it to install dependencies, for example `npm ci --prefix kit --no-audit --no-fund`. A setup that fails parks the run, and an answer runs setup and the step again.

The image is built from `infra/local/sandbox`. `smoke.sh` there checks it the way a run uses it.

## Toolchains

The image carries toolchain managers and a C compiler, not toolchains. Every container mounts the docker volume `bothub-cache` at `/cache`, and rustup and cargo keep their homes there, so a toolchain installed once serves every later run, check and data dir.

When a run's checkout is made, a toolchain step installs what the repo names. It is one container on docker's default network, so it reaches any host, and it runs on the files of the checkout's base commit, never on files a run wrote. It reads the repo's root files:

| Files                                                   | Installs                                                                     |
| ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `Cargo.toml`, `rust-toolchain` or `rust-toolchain.toml` | The pinned toolchain, or stable, with clippy and rustfmt, then `cargo fetch` |

Then it runs the hub's `toolchain` script, for what the repo files do not name, such as a target or a cargo subcommand:

```yaml
toolchain: rustup target add wasm32-unknown-unknown && cargo install --locked cargo-nextest
```

A failed step stops the run with its output. The step runs once per base commit and script in a runner process. On a warm volume it takes seconds, since rustup and cargo find everything installed. Checks then build offline from the fetched crates. <!-- code: src/docker.ts#toolchainOf -->

`BOTHUB_CACHE_VOLUME` names another volume, and an empty value turns off both the volume and the step. The volume is writable by every run, so treat it like the egress network: a run could leave files there that later runs use. `docker volume rm bothub-cache` starts it over.

## A hub's own image

`image` in `hub.yaml` names a local image that every command of a run starts in: sessions, setup, scripts and checks. bothub never builds or pulls it. Build it beforehand from the sandbox image, so the harnesses are already in it, and add what the repo needs, such as a toolchain or installed dependencies:

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
