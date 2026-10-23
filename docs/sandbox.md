# Sandbox and models

## The sandbox

Sessions, script steps, checks and checkout setup run in throwaway Docker containers. Without Docker or the internal network, the run hits a [runner error](loop.md#order-and-limits).

A container has a read-only root, a tmpfs `/tmp`, the operator's non-root uid, no capabilities, `no-new-privileges`, 4g of memory, 1.5 CPUs, 512 pids and a timeout watchdog. Images are never pulled.

`/work` (the checkout) and the session home `/home/agent` are writable. `/hub` (`AGENTGRAPH_HUB`) and the mirror are read only. The shared cache is at `/cache`, where a checkout's writes stay with that checkout. No Docker socket or GitHub token enters a session; it gets only its agent's model key. <!-- code: src/docker.ts#dockerArgs -->

`infra/local/sandbox` builds the image, and its `smoke.sh` checks how containers behave. Tests use a host sandbox instead, which runs in a clone without network rules. <!-- code: tests/doubles/sandbox.ts#host -->

## The network

Sessions and checkout setup use the hub's `network`:

| `network` | Docker network | Reachable |
| --- | --- | --- |
| `egress` (default) | `agentgraph-sandbox` | Model proxy, the optional Ollama relay, an HTTPS allowlist |
| `models` | `agentgraph-models` | Model proxy only |

The local compose stack creates both internal networks. The allowlist in `infra/local/egress/allowlist` has `github.com`, `codeload.github.com`, `objects.githubusercontent.com` and `registry.npmjs.org`: GitHub downloads and npm installs, but no PyPI, crates.io, Docker Hub, SSH or browsing. Scripts and checks get no network at all. Environment builds use Docker's default network.

Hub `setup` installs dependencies, for example `npm ci --prefix kit --no-audit --no-fund`. With `models`, they must already be in the image or the environment. A failed checkout setup retries, then parks the run; an answer retries setup and the step. <!-- code: src/engine.ts#setUp -->

## Environments

An environment caches a repo's dependencies so checkouts do not install them again. Its files live in the volume `agentgraph-lower-<key>`, and the image `agentgraph-env/<repo>:<key>` carries its labels. To build one, a container takes the files package managers read from the base commit (lockfiles, manifests and the like), installs [toolchains](#toolchains), runs hub `setup`, and keeps the ignored dependency folders such as `node_modules` and `target`. <!-- code: src/env.ts#envOf src/env.ts#skeletonOf -->

The key covers the base image, the toolchain commands, `setup` and those files, so bases that differ only in source share an environment. If setup fails on those files alone, the build retries with the whole base. A setup that reads `$AGENTGRAPH_HUB` runs per checkout instead. A run's trace says which environment each checkout used and how it was built.

Each checkout mounts private overlays over the cached dependency folders, so its writes stay its own, and the overlays go when the checkout closes. Checkouts skip setup when the environment holds everything setup produced; resumed checkouts and incomplete environments run it again. <!-- code: src/env.ts#layer src/docker.ts#docker src/env.ts#unlogged -->

`AGENTGRAPH_STATE` (default `~/.cache/agentgraph`) holds runner heartbeats and image use times. Runners that share Docker must share it, and startup removes what dead runners left behind.

### Disk

Cache is collected by the bytes only it holds: environments and their volumes, and the score trees under `--root` or `AGENTGRAPH_GC_ROOTS`. Unused volumes, environments no run can reuse and score trees nobody holds always go. The rest goes least recently used first while the total is over `AGENTGRAPH_ENV_CAP` (`60g`). Nothing goes while a container uses it, a live checkout overlays it, another live runner used it in the last `AGENTGRAPH_ENV_HOLD_HOURS` (2), or a pin names it.

```sh
node bin/env.ts list
node bin/env.ts collect --dry-run --root <tune root>
node bin/env.ts pin luna-full 'agentgraph-env/*' --days 14
node bin/env.ts unpin luna-full
node bin/env.ts sweep
```

A pin holds what its globs name until it expires. `collect` without `--dry-run` removes, and `sweep` removes dependency volumes of dead runners. Collection also runs after each bench case and when disk runs low: below `AGENTGRAPH_MIN_FREE_GB` (40) free in the data directory or Docker's disk, cleanup runs, and if that is not enough, `disk low` names what holds the space and bench work waits. Running containers are never stopped. <!-- code: src/disk.ts#collect src/disk.ts#room -->

### Toolchains

The sandbox has toolchain managers and a C compiler. The `agentgraph-cache` volume at `/cache` shares rustup, cargo and npm, pnpm and yarn downloads across runs. Only environment builds write it; everything else writes to an overlay that goes with the checkout, and the trace counts those files (`cache`).

A root `rust-toolchain` or `rust-toolchain.toml` pins Rust, and `Cargo.toml` alone selects stable, with clippy, rustfmt and the crates fetched. Hub `toolchain` adds anything else:

```yaml
toolchain: rustup target add wasm32-unknown-unknown && cargo install --locked cargo-nextest
```

A failed toolchain install is a runner error with its output. `AGENTGRAPH_CACHE_VOLUME` names another volume, and an empty value turns off the cache and environments. `docker volume rm agentgraph-cache` clears it. <!-- code: src/env.ts#toolchainOf src/env.ts#written src/docker.ts#dockerArgs -->

## A hub's own image

Hub `image` names a local image for every run command and environment build, instead of `AGENTGRAPH_IMAGE` or `agentgraph-sandbox:local`. Build it yourself with the harnesses and any dependencies; agentgraph never builds or pulls it.

```dockerfile
FROM agentgraph-sandbox:local
USER root
COPY package.json package-lock.json /
RUN npm ci --no-audit --no-fund && npm cache clean --force
ENV PATH=/node_modules/.bin:$PATH
USER node
```

Node finds `/node_modules` from `/work`. Those dependencies stay as built even when a pull request changes the lockfile.

```yaml
image: acme-node:agentgraph
network: models
```

## Harnesses

An agent's `harness` picks the session program:

| Harness | Tool permissions | Aside fork |
| --- | --- | --- |
| `opencode` | Allowlists with patterns, such as `bash(git diff*)` | `--session <id> --fork` |
| `pi` | Plain tool names only; a patterned tool such as `bash(npm test*)` is dropped, so best for read-only agents | `--fork <id>` |
| `claude` | Claude Code through the proxy's Anthropic endpoint; patterns work | `--resume <id> --fork-session` |

Agent `tools` defaults to none. Bash patterns also allow the `NODE_OPTIONS= command ` prefix. Session homes under `homes/` in the data directory persist across resumes, and [asides](loop.md#asides) copy them before forking. <!-- code: src/harnesses.ts#harnesses -->

## Models

An agent's `model` names a proxy alias. Without one, opencode and pi ask for `default`, which the local proxy config does not define, so give those agents a `model`. Claude Code uses its own default. `infra/local/litellm.config.yaml` maps aliases to providers and logs spend per agent key, so moving an alias to another provider or subscription needs no agent edit.

`AGENTGRAPH_PROXY_KEYS` holds `name=key` pairs, separated by commas or spaces; an agent without a key cannot start a session. Inside the container the key is `AGENTGRAPH_LLM_API_KEY` for opencode and pi and `ANTHROPIC_AUTH_TOKEN` for Claude Code; opencode also gets `AGENTGRAPH_LLM_BASE_URL`. Keys pass by environment name, never in arguments, and are masked in output. <!-- code: src/harnesses.ts#keysOf -->

Usage the harness does not price, subscriptions included, is priced from `AGENTGRAPH_PRICES` (default `infra/local/prices.json`), with its source. A model missing from the table is marked `unpriced` in the trace, never $0. <!-- code: src/harnesses.ts#priced -->
