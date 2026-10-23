# Sandbox and models

## The sandbox

Sessions, script steps, checks and checkout setup run in disposable Docker containers. Missing Docker or an unusable internal network causes a [runner error](loop.md#order-and-limits).

Containers have a read-only root, tmpfs `/tmp`, the operator's non-root uid, no capabilities, `no-new-privileges`, 4g memory, 1.5 CPUs, 512 pids and a timeout watchdog. Images are never pulled.

`/work` and the session home `/home/agent` are writable. `/hub` (`AGENTGRAPH_HUB`) and the bare mirror are read only. The shared cache mounts at `/cache`: a checkout's commands see it through their own overlay, so what they write stays with the checkout, and a command outside a checkout sees it read-only. No Docker socket or GitHub token enters a session; it receives only its agent's model key. The host applies [proposals](proposals.md) after checks. <!-- code: src/docker.ts#dockerArgs -->

## The network

Sessions and checkout setup use the hub's network:

| `network` | Docker network | Reachable services |
| --- | --- | --- |
| `egress` (default) | `agentgraph-sandbox` | Model proxy, optional Ollama relay, HTTPS allowlist |
| `models` | `agentgraph-models` | Model proxy only |

The local compose stack creates these internal networks. The `sandbox` profile adds the relay to host Ollama. The egress allowlist in `infra/local/egress/allowlist` permits `github.com`, `codeload.github.com`, `objects.githubusercontent.com` and `registry.npmjs.org`: GitHub downloads and npm installs, but no PyPI, crates.io, Docker Hub, SSH, browsing or search. Scripts and checks have no network.

Environment builds use unrestricted Docker networking; see [Environments](#environments). With `models`, dependencies must already be in the image or environment.

Hub `setup` installs dependencies, for example `npm ci --prefix kit --no-audit --no-fund`. Failed checkout setup retries, then parks the run; answering retries setup and the step. <!-- code: src/engine.ts#setUp -->

Build the sandbox from `infra/local/sandbox`; its `smoke.sh` checks container behavior.

## Environments

An environment caches a repo's dependencies. Its files live in the volume `agentgraph-lower-<key>`; the image `agentgraph-env/<repo>:<key>` only carries its labels. A build container works straight in that volume at `/work`:

1. Unpacks the skeleton of the base from the read-only mirror: the files a package manager or toolchain reads (lockfiles, manifests, `.npmrc`, `.nvmrc`, `patches/`, `.yarn/releases` and the like), the ignore rules, and empty stubs for Cargo targets.
2. Installs [toolchains](#toolchains) and runs hub `setup`.
3. Moves ignored `node_modules` and `target` directories to `.agentgraph-env/data`, other ignored directories to `.agentgraph-env/rest`, and drops the source.

So two bases that differ only in source share one environment. When setup fails on the skeleton, the build runs again on every file of the base, and later bases with the same toolchain and setup go there first. A run's trace says which environment a checkout started from, how it was built, and whether it was built from the checkout's own files (`env`).

The build uses Docker's default network, reaching any host. Its key covers the base image, toolchain commands, setup, and the skeleton or the whole base. Matching environments are reused. Setup referencing `$AGENTGRAPH_HUB` runs per checkout instead. Setup failing on every file falls back to checkout setup. <!-- code: src/env.ts#envOf src/env.ts#skeletonOf -->

Each checkout mounts private overlay volumes over cached dependency directories, or copies where overlays are unsupported. Writes stay local; relative workspace links still resolve against checkout files. Other possible dependency directories get empty volumes: `node_modules` beside each `package.json`, and `target` beside each outermost `Cargo.toml`. Dependencies stay outside checkout folders even without an environment or after failed setup.

Smaller outputs such as `dist` and wasm `pkg` are copied into the checkout so builds can delete and recreate them. Closing the checkout removes its volumes. Checkouts skip setup when the environment captured all outputs and was built from the same skeleton or files; resumed checkouts, or incomplete environments, run setup again. <!-- code: src/env.ts#layer src/docker.ts#docker -->

Containers keep no Docker log, since the runner reads their output as they run. A command's container is removed before the command returns, however it ends. <!-- code: src/env.ts#unlogged src/docker.ts#docker -->

Runner ids and heartbeat files identify abandoned checkouts and volumes, removed on startup. `AGENTGRAPH_STATE` defaults to `~/.cache/agentgraph` and also holds image last-use stamps. Runners sharing Docker must share this directory; containerized runners need it on persistent storage.

Cache is collected by unique bytes: an image counts only the layer its build added, plus its dependency volume. The collector sees Env images and dependency volumes, the old engine's `bothub-env/*` images and `bothub-*` cache volumes, and score trees and `target-shared` dirs (with `CACHEDIR.TAG`) under `--root` or `AGENTGRAPH_GC_ROOTS`. Compose volumes and `bothub_*` volumes are data and never listed. Dependency volumes no image uses, Envs no run can reuse (built by another Env version, or on a base image its tag no longer names), the old engine's layer volumes and score trees nobody holds always go. The rest goes least recently used first, the old engine's first, while the total is over `AGENTGRAPH_ENV_CAP` (`60g`). Nothing goes while a container uses it, a live checkout overlays it, another live runner used it in the last `AGENTGRAPH_ENV_HOLD_HOURS` (2), or a pin names it. Collection runs after each bench case and when disk runs low:

```sh
node bin/env.ts list
node bin/env.ts collect --dry-run --root <tune root>
node bin/env.ts pin luna-full 'bothub-env/*' bothub-cache --days 14
node bin/env.ts unpin luna-full
```

A pin holds what its globs name until it expires; then those items fall back into the normal order. Omit `--dry-run` to remove. Before checkouts, builds and commands, free space is checked in both the data directory and Docker disk. Below `AGENTGRAPH_MIN_FREE_GB` (40), cleanup runs; if that is not enough, `disk low` names the held cache and the command that frees it, and bench work waits until space returns. Running containers are never stopped. <!-- code: src/disk.ts#collect src/disk.ts#room -->

`AGENTGRAPH_IMAGE` supplies the base image when hub `image` is absent; default `agentgraph-sandbox:local`.

### Toolchains

The sandbox carries toolchain managers and a C compiler. `agentgraph-cache` at `/cache` shares rustup, cargo and npm/pnpm/yarn downloads across runs, environment builds and data directories. These tools lock writes except yarn 1.

Root `rust-toolchain` or `rust-toolchain.toml` selects pinned Rust; `Cargo.toml` alone selects stable. The step adds clippy and rustfmt and fetches crates when a Cargo manifest exists. Then hub `toolchain` adds anything else:

```yaml
toolchain: rustup target add wasm32-unknown-unknown && cargo install --locked cargo-nextest
```

A volume lock serializes toolchain installs. Warm caches avoid downloads; checks build offline. Toolchain failure raises a runner error with output. <!-- code: src/env.ts#toolchainOf -->

Only environment builds write the cache volume. Sessions, checkout setup and score commands write into an overlay that is removed with the checkout; where Docker cannot mount overlays, `/cache` is read-only and npm, pnpm and yarn download into `/tmp`. A run's trace counts the files its checkout wrote there (`cache`), and a score records the same count, 0 when nothing reran setup. <!-- code: src/env.ts#layer src/env.ts#written src/docker.ts#dockerArgs -->

`AGENTGRAPH_CACHE_VOLUME` changes the volume; an empty value disables it and environments. `docker volume rm agentgraph-cache` clears it.

## A hub's own image

Hub `image` selects a local image for every run command and environment build. Build it beforehand with harnesses and required dependencies; agentgraph never builds or pulls the supplied image.

```dockerfile
FROM agentgraph-sandbox:local
USER root
COPY package.json package-lock.json /
RUN npm ci --no-audit --no-fund && npm cache clean --force
ENV PATH=/node_modules/.bin:$PATH
USER node
```

Node resolves `/node_modules` from `/work`. Those dependencies stay as built even when a pull request changes the lockfile.

```yaml
image: acme-node:agentgraph
network: models
```

Tests use a host sandbox that runs directly in a clone without network rules. <!-- code: tests/doubles/sandbox.ts#host -->

## Harnesses

Agent `harness` selects the session program:

| Harness | Tool permissions | Aside fork |
| --- | --- | --- |
| `opencode` | Allowlists, including `bash(git diff*)` | `--session <id> --fork` |
| `pi` | Plain tool names; drops patterns, so use for read-only agents | `--fork <id>` |
| `claude` | Claude Code through the proxy's Anthropic endpoint; patterned tools | `--resume <id> --fork-session` |

Agent `tools` defaults to none. Bash patterns also permit the `NODE_OPTIONS= command ` prefix. Adapters normalize session events. Private homes under data `homes/` persist on resume; [asides](loop.md#asides) copy them before forking. <!-- code: src/harnesses.ts#harnesses -->

## Models

Agent `model` names a proxy alias. Without it, opencode and pi use `default`; Claude Code uses its own default. LiteLLM maps aliases to upstreams in `infra/local/litellm.config.yaml` and logs spend by agent key. Changing an alias's provider or subscription requires no agent edit.

`AGENTGRAPH_PROXY_KEYS` holds `name=key` pairs separated by commas or spaces. Missing agent keys prevent sessions. `AGENTGRAPH_PROXY_URL` selects the proxy. Inside containers, keys use `AGENTGRAPH_LLM_API_KEY` for opencode/pi and `ANTHROPIC_AUTH_TOKEN` for Claude Code; opencode uses `AGENTGRAPH_LLM_BASE_URL`. Secrets pass by environment name, never argv, and harness output masks them. <!-- code: src/harnesses.ts#keysOf -->

Usage the harness does not price, including subscriptions, uses list prices from `AGENTGRAPH_PRICES` or `infra/local/prices.json`, each with its source. A model the table lacks is marked `unpriced` in the trace, never $0. <!-- code: src/harnesses.ts#priced -->
