# Sandbox and models

## The sandbox

Sessions, script steps, checks and checkout setup run in throwaway Docker containers. Without Docker or the internal network, the run hits a [runner error](loop.md#order-and-limits).

A container has a read-only root, a tmpfs `/tmp`, the operator's non-root uid, no capabilities, `no-new-privileges`, 4g of memory, 1.5 CPUs, 512 pids and a timeout watchdog. Images are never pulled.

`/work` (the checkout) and the session home `/home/agent` are writable. The mirror is read only, and so is `/graph` (`AGENTGRAPH_DIR`), which scripts and setup get but sessions do not. The shared cache is at `/cache`, where a checkout's writes stay with that checkout. No Docker socket or GitHub token enters a session; it gets only its agent's model key. <!-- code: src/docker.ts#dockerArgs -->

`infra/local/sandbox` builds the image, and its `smoke.sh` checks how containers behave. Tests use a host sandbox instead, which runs in a clone without network rules. <!-- code: tests/doubles/sandbox.ts#hostSandbox -->

## The network

Sessions and checkout setup use the graph's `network`:

| `network` | Docker network | Reachable |
| --- | --- | --- |
| `egress` (default) | `agentgraph-sandbox` | Model proxy, the optional Ollama relay, an HTTPS allowlist |
| `models` | `agentgraph-models` | Model proxy only |

The local compose stack creates both internal networks. The allowlist in `infra/local/egress/allowlist` has `github.com`, `codeload.github.com`, `objects.githubusercontent.com` and `registry.npmjs.org` for GitHub downloads and npm installs, and `api.anthropic.com`, `chatgpt.com` and `auth.openai.com` for harnesses on their own login and for LiteLLM. No PyPI, crates.io, Docker Graph, SSH or browsing. Scripts and checks get no network at all. Environment builds use Docker's default network.

Graph `setup` installs dependencies, for example `npm ci --prefix kit --no-audit --no-fund`. With `models`, they must already be in the image or the environment. A failed checkout setup retries, then parks the run; an answer retries setup and the step. <!-- code: src/engine.ts#setUp -->

## Environments

An environment caches a repo's dependencies so checkouts do not install them again. Its files live in the volume `agentgraph-lower-<key>`, and the image `agentgraph-env/<repo>:<key>` carries its labels. To build one, a container takes the files package managers read from the base commit (lockfiles, manifests and the like), installs [toolchains](#toolchains), runs graph `setup`, and keeps the ignored dependency folders such as `node_modules` and `target`. <!-- code: src/env.ts#readSandboxSetup src/env.ts#readDependencySkeleton -->

The key covers the base image, the toolchain commands, `setup` and those files, so bases that differ only in source share an environment. If setup fails on those files alone, the build retries with the whole base. A setup that reads `$AGENTGRAPH_DIR` runs per checkout instead. A run's trace says which environment each checkout used and how it was built.

Each checkout mounts private overlays over the cached dependency folders, so its writes stay its own, and the overlays go when the checkout closes. Checkouts skip setup when the environment holds everything setup produced; resumed checkouts and incomplete environments run it again. <!-- code: src/env.ts#createSharedMounts src/docker.ts#dockerSandbox src/env.ts#unlogged -->

`AGENTGRAPH_STATE` (default `~/.cache/agentgraph`) holds runner heartbeats, image use times and build locks. Runners that share Docker must share it, and startup removes what stopped runners left behind. One environment key builds under one lock, so runners that start at once wait for the first build and reuse it. The `agentgraph-sandbox:local` and `agentgraph-egress:local` images build under one shared lock too. A checkout builds the sandbox image when it is missing; any other missing image fails the checkout with the `docker pull` command to run. <!-- code: src/owner.ts#waitForLock src/docker.ts#ensureImage -->

One check decides whether the process that owns something still runs: run locks, checkouts, dependency volumes, held environments and the bench and tune locks all ask it. An owner is a pid, plus a random owner id when the process beats. It still runs while its heartbeat is under two minutes old, or while its pid runs and it wrote its claim after the machine last booted. <!-- code: src/owner.ts#isOwnerRunning src/owner.ts#isLockedByOtherProcess -->

### Disk

Cache is collected by the bytes only it holds: environments and their volumes, and the score trees under `--root` or `AGENTGRAPH_GC_ROOTS`. Unused volumes, environments no run can reuse and score trees nobody holds always go. The rest goes least recently used first while the total is over `AGENTGRAPH_ENV_CAP` (`60g`). Nothing goes while a container uses it, a live checkout overlays it, another live runner used it in the last `AGENTGRAPH_ENV_HOLD_HOURS` (2), or a pin names it.

```sh
node bin/env.ts list
node bin/env.ts collect --dry-run --root <tune root>
node bin/env.ts pin luna-full 'agentgraph-env/*' --days 14
node bin/env.ts unpin luna-full
node bin/env.ts sweep
```

A pin holds what its globs name until it expires. `collect` without `--dry-run` removes, and `sweep` removes dependency volumes of dead runners. Collection also runs after each bench case and when disk runs low: below `AGENTGRAPH_MIN_FREE_GB` (40) free in the data directory or Docker's disk, cleanup runs, and if that is not enough, `disk low` names what holds the space and bench work waits. Running containers are never stopped. <!-- code: src/disk.ts#collect src/disk.ts#ensureFreeDisk -->

### Toolchains

The sandbox has toolchain managers and a C compiler. The `agentgraph-cache` volume at `/cache` shares rustup, cargo and npm, pnpm and yarn downloads across runs. Only environment builds write it; everything else writes to an overlay that goes with the checkout, and the trace counts those files (`cache`).

A root `rust-toolchain` or `rust-toolchain.toml` pins Rust, and `Cargo.toml` alone selects stable, with clippy, rustfmt and the crates fetched. Graph `toolchain` adds anything else:

```yaml
toolchain: rustup target add wasm32-unknown-unknown && cargo install --locked cargo-nextest
```

A failed toolchain install is a runner error with its output. `AGENTGRAPH_CACHE_VOLUME` names another volume, and an empty value turns off the cache and environments. `docker volume rm agentgraph-cache` clears it. <!-- code: src/env.ts#makeToolchainSetupCommands src/env.ts#written src/docker.ts#dockerArgs -->

## A graph's own image

Graph `image` names a local image for every run command and environment build, instead of `AGENTGRAPH_IMAGE` or `agentgraph-sandbox:local`. Build it yourself with the harnesses and any dependencies; agentgraph never builds or pulls it, and a checkout without it fails with the command to run.

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

An agent's `harness` picks the session program by name. The runner's `agentgraph.config.ts`, or the file `AGENTGRAPH_CONFIG` names, lists the harness plugins. The operator owns that file; a graph never loads code. A plugin is an object with a `name`, the env var its `key` goes in, an optional `home` of files and links, the `command` to run and a `parse` that turns each output line into pieces, and an optional `check` that lists what it cannot do for an agent. The built-in four live in `harnesses/` and are written the way your own would be. Say a harness prints one JSON object per line:

```jsonl
{"kind":"start","id":"s1"}
{"kind":"say","text":"Fixed the typo."}
{"kind":"end","ok":true}
```

Its plugin, added to the list:

```ts
import type { Harness, HarnessSettings } from './src/harnesses.ts';

const echo = (): Harness => ({
  name: 'echo',
  key: 'ECHO_API_KEY',
  check: agent => (agent.tools.length ? ['takes no tools'] : []),
  command: (spec, route) => ({
    cmd: 'echo-agent',
    args: ['--json', '--base-url', route.url, '--model', route.model, '--', spec.prompt],
  }),
  parse: () => line => {
    const event = line as { kind?: string; id?: string; text?: string; ok?: boolean };
    if (event.kind === 'start' && event.id) return [{ type: 'session', id: event.id }];
    if (event.kind === 'say' && event.text) return [{ type: 'text', text: event.text }];
    if (event.kind === 'end') return [{ type: 'done', ended: event.ok ? 'stop' : 'error' }];
    return [];
  },
});

export default { harnesses: [opencode(), claude(), pi(), echo()], providers: makeProviders() } satisfies HarnessSettings;
```

The package has no entry point yet, so a plugin imports its types from `src/harnesses.ts`, and the schema and parsing helpers the built-in four share from `harnesses/helpers.ts`. What the session loop does around a plugin:

- `parse` gets each line already parsed as JSON. A line that is not JSON is kept as the error tail, which becomes the final reply when the session fails with no reply and no error of its own.
- The first `session` piece starts the session; later ones are ignored. A session that ends without a `done` piece ends in `error`.
- `command` and `home` get the model from the route only. The route also holds the proxy URL, and the loop puts the agent's key in the `key` env var.
- `home` paths are relative to the session home and cannot leave it.
- `check` returns what the harness cannot do, phrased to follow its name, such as `takes no tools`. The graph reports it as `harness: echo takes no tools`.

`AGENTGRAPH_HARNESS` runs every agent on that harness. Otherwise an agent without a `harness` gets the first harness `AGENTGRAPH_PROVIDER` serves, else the first in the config. A graph loads only when every agent's harness is in the config and its `check` finds nothing. A config that does not load fails every graph with its problem. A graph names a harness and never holds a key or a model address. <!-- code: src/harnesses.ts#Harness agentgraph.config.ts src/harnesses.ts#readHarnessSettings src/folder.ts#loadGraph -->

| Harness | Tool permissions | Aside fork |
| --- | --- | --- |
| `opencode` | Allowlists with patterns, such as `bash(git diff*)` | `--session <id> --fork` |
| `pi` | Plain tool names only; a patterned tool such as `bash(npm test*)` fails the graph check, so best for read-only agents | `--fork <id>` |
| `claude` | Claude Code through the proxy's Anthropic endpoint; patterns work, a tool Claude Code lacks fails the graph check | `--resume <id> --fork-session` |
| `codex` | An agent with `edit`, `write` and `bash` gets every tool Codex has; any other runs in Codex's read-only sandbox, so `bash(git diff*)` means read-only shell. Granting only some of the three, or a pattern on any tool but `bash`, fails the graph check. Codex always talks to the gateway as its own model provider (`wire_api = "responses"`) with the agent's key, so a ChatGPT subscription works only behind a gateway that holds the login, such as LiteLLM's `chatgpt/` models. Sessions live in the session home | none; an aside starts a fresh session |

Agent `tools` defaults to none. Bash patterns also allow the `NODE_OPTIONS= command ` prefix. Session homes under `homes/` in the data directory persist across resumes, and [asides](loop.md#asides) copy them before forking. <!-- code: src/harnesses.ts#harnessSession -->

## Models

An agent's `model` is the name its endpoint expects, such as a gateway alias. `AGENTGRAPH_MODELS` maps aliases to other names as `alias=model` pairs, with `*` for agents without a `model`. Without one, opencode and pi ask for `default`, so give those agents a `model`. Claude Code uses its own default. Locally, `infra/local/litellm.config.yaml` maps aliases to providers and logs spend per agent key, so moving an alias to another provider or subscription needs no agent edit.

`AGENTGRAPH_PROXY_URL` is the base URL, one for every harness or `harness=url` pairs, and `AGENTGRAPH_PROXY_KEYS` holds `agent=key` pairs, with `*` for any other agent; both are separated by commas or spaces. A harness without a URL uses its own endpoint, and an agent without a key runs on its harness's own login. Inside the container the key is `AGENTGRAPH_LLM_API_KEY` for opencode and pi and `ANTHROPIC_AUTH_TOKEN` for Claude Code; opencode also gets `AGENTGRAPH_LLM_BASE_URL`. `AGENTGRAPH_SESSION_ENV` names engine variables every session gets as well. Keys pass by environment name, never in arguments, and are masked in output. [Hosting](hosting.md#models) has the settings for each kind of gateway. <!-- code: src/harnesses.ts#harnessSession -->

Usage the harness does not price, subscriptions included, is priced from `AGENTGRAPH_PRICES` (default `infra/local/prices.json`), with its source. A model missing from the table is marked `unpriced` in the trace, never $0. <!-- code: src/harnesses.ts#priced -->

## Secrets on the host

A session gets only its agent's model key. On the host, these keep long-lived keys out of what other processes inherit or can see:

- Only `AGENTGRAPH_APP_KEY`, `AGENTGRAPH_PROXY_KEYS` and the names in `AGENTGRAPH_SESSION_ENV` may come from a file, named by the setting plus `_FILE`. Each start reads that file once. Keys from the bench keys file stay in the runner's memory and reach `process.env` only for a bench engine pinned by `BENCH_ENGINE`. <!-- code: src/main.ts#readEngineEnv bin/bench.ts#readBenchKeys -->
- Host git, docker and environment builds get a short list of variables: `PATH`, `HOME`, `USER`, `TMPDIR`, the locale, `TZ` and the Docker settings. They never get the runner's whole environment. <!-- code: src/git.ts#makeHostEnv -->
- `infra/local/keys.sh` unexports every name in `.env` and every inherited name with a `KEY`, `KEYS`, `TOKEN`, `SECRET` or `PASSWORD` part. curl reads the key from a header file and the request body from stdin, so neither shows in a process list.
- npm runs no install scripts. The `.npmrc` in `agentgraph/` and in `studio/` sets `ignore-scripts=true`, and `min-release-age=7` skips versions published in the last week. The sandbox image installs with `--ignore-scripts` and runs one postinstall by hand, opencode's, which links its platform binary.
- The studio dev server serves files only from `studio/`, `src/` and `node_modules/`, and refuses env, key, certificate and `.npmrc` files even there. Its fixture APIs still read the graph and data you point it at. <!-- code: studio/vite.config.ts#deny -->
- On macOS, `bin/setup-app.ts` keeps the App key in the login Keychain, which asks before every read. [App setup](../infra/github/README.md#create-the-app) has the start command.

### The leak probe

`node bin/leak-probe.ts` looks where an npm worm looks: its own environment, the repo's ignored files with `~/.agentgraph` and `~/.config/agentgraph`, the process list, running containers' environments, and the studio's `/@fs` route. It prints where each hit is, never the value.

```sh
node bin/leak-probe.ts
node bin/leak-probe.ts env ps docker
```

Files count only when they hold a value shaped like a real key: `sk-` keys with a digit (LiteLLM, OpenRouter, Anthropic), GitHub `ghp_`, `ghs_` and `github_pat_` tokens, a private key block with a body, AWS access key ids and Slack tokens. Variable names alone never make a file hit. It skips `*.example`, test files, binaries and build output such as `node_modules`, `target`, `dist` and `build`. Environments, processes and containers count a value of that shape, or a variable named like a key (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`). Processes with the same command and names share a line. <!-- code: bin/leak-probe.ts#secret -->

The output has two groups. **Expected** holds keys at rest: `infra/local/.env` and `.keys.env`, the App's `key.pem` under `~/.config/agentgraph`, and the proxy and database containers. **Look at this** holds everything else, and each line there is a copy to remove or a process that inherited a key. The last line counts both groups by place. It exits 1 when something is under look at this, 3 when a probe could not run, and 0 otherwise.

`PROBE_PATHS` replaces the file roots, `PROBE_STUDIO` sets the studio address (`http://127.0.0.1:5182`), and `PROBE_CANARY` adds a value to look for.

### Not covered yet

Code running as your user can still read the files, the Keychain after a prompt, and the runner's memory. These wait for a later design of auth and secrets:

- a signer or broker that holds the App key, so the runner never sees it
- a separate macOS user for the runner
- per-run model keys that expire
- egress limits at the model gateway
- the tune proposer in the sandbox, the `models` network by default, and environment builds behind the proxy
