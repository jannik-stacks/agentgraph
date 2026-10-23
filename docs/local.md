# Running it locally

Requires Node 22.18 or later and Docker. Commands run from `agentgraph/` unless stated otherwise.

## The model stack

From `infra/local`:

```sh
cp .env.example .env              # set LITELLM_MASTER_KEY and provider keys
docker compose up -d
docker compose --profile sandbox up -d
docker build -t agentgraph-sandbox:local sandbox
./keys.sh                         # virtual keys in .keys.env
```

The compose project is always `agentgraph`. A stack still running as project `bothub` moves once with `./migrate-from-bothub.sh` ([Moving from the bothub project](../infra/local/README.md#moving-from-the-bothub-project)).

[Local infrastructure](../infra/local/README.md) covers provider setup, including the ChatGPT login for `smart`. Rust toolchains warm a shared cache on first use; see [Toolchains](sandbox.md#toolchains).

For GitHub, create an App with `node bin/setup-app.ts` ([App setup](../infra/github/README.md)). Set `AGENTGRAPH_APP_ENV` to its `app.env`. From `infra/local`, prepare a persistent data directory:

```sh
./e2e.sh ~/agentgraph-data ../../examples/sandbox
```

The script converts agent keys to `AGENTGRAPH_PROXY_KEYS` in the data directory's `.env` and prints commands. Source that file as instructed; the runner does not load it automatically. Instances load their own `keys.env` instead.

## The CLI

```sh
node bin/run.ts check --hub examples/sandbox
node bin/run.ts --hub examples/sandbox --issue 3 --data ~/agentgraph-data
node bin/run.ts --hub examples/sandbox --all --data ~/agentgraph-data
node bin/run.ts loop --hub examples/sandbox --data ~/agentgraph-data
node bin/run.ts status --hub examples/sandbox --data ~/agentgraph-data
```

| Command | Behavior |
| --- | --- |
| `check` | Validate a hub; print file-specific problems or `ok`. No model or container needed. |
| `--issue <n>` | Start or resume one issue's run and drive until waiting or finished. Print id, step, status and reason. |
| `--all` | Sweep open issues, starting only on trusted commands or labels, up to `limits.parallel` at once. |
| `loop` | Sweep at startup, then every `AGENTGRAPH_EVERY` minutes. Without `--hub`, use the repo's [own hub](loop.md#a-hub-in-the-repo) and `AGENTGRAPH_REPO`. |
| `status` | List human waits and continuation commands. With GitHub, require App credentials and warn about installations reaching other repos. |

`--hub`, `--data` and `--forge` select local folders; `--forge` replaces GitHub. `--instance` supplies all three. The CLI sets `AGENTGRAPH_HUB`, `AGENTGRAPH_DATA`, `AGENTGRAPH_FORGE` and the hub's `repo` as `AGENTGRAPH_REPO`.

Keep data outside temporary directories: macOS can delete untouched files after three days. Startup warns when data or its mirror is temporary. <!-- code: src/main.ts#start src/main.ts#temporary -->

The runner reads these settings: <!-- code: src/services.ts#settings -->

| Variable | Meaning or default |
| --- | --- |
| `AGENTGRAPH_APP_ENV` | Env file holding `AGENTGRAPH_APP_ID` and `AGENTGRAPH_APP_KEY` |
| `AGENTGRAPH_APP_KEY_FILE` | Private-key path in that file; loaded as `AGENTGRAPH_APP_KEY` |
| `AGENTGRAPH_EVERY` | Poll interval in minutes, 5 |
| `AGENTGRAPH_PROXY_URL` | Model proxy, `http://litellm:4000/v1` |
| `AGENTGRAPH_PROXY_KEYS` | Per-agent keys; see [Models](sandbox.md#models) |
| `AGENTGRAPH_PRICES` | List prices, `infra/local/prices.json` |
| `AGENTGRAPH_CHECK_LOGS` | `all`, `failed` or `off`; see [Check logs](runs.md#check-logs) |
| `AGENTGRAPH_CACHE_VOLUME` | Shared [toolchain cache](sandbox.md#toolchains) |
| `AGENTGRAPH_IMAGE` | Default [environment image](sandbox.md#environments) |
| `AGENTGRAPH_STUDIO_URL` | Optional [provenance links](runs.md#provenance) |

App credentials also work directly in the environment. `--logs` or instance `logs` sets `AGENTGRAPH_CHECK_LOGS`. The CLI requires `--data` outside an instance. The underlying runner setting defaults to `.bothub-data`; `~/.agentgraph` is the studio's default.

Routing commands use the same engine rules as [router proposals](loop.md#routing):

```sh
node bin/run.ts say --hub <dir> --data <dir> --issue <n> [--comment <review comment id>] "<text>"
node bin/run.ts tell --data <dir> --issue <n> "<text>"
node bin/run.ts dispatch --hub <dir> --data <dir> --workflow <name> --issue <n> [--step <step>]
```

`say` runs the router immediately and replies at the source location. `tell` queues text for a live run's next look, refusing if none exists. `dispatch` starts an eligible workflow. These also accept `--forge` and `--instance`.

## Without GitHub

A forge folder replaces GitHub; no App is needed. It contains `<n>.md` issues, `<n>.jsonl` timelines, `<n>/pull.json` and `diff.patch` for pull requests, and a bare `origin.git`. <!-- code: src/forge.ts#fileForge -->

```sh
node bin/forge.ts /tmp/forge init ../path/to/repo
node bin/forge.ts /tmp/forge issue "Reject a negative count" --body issue.md
node bin/forge.ts /tmp/forge comment 1 /agent
node bin/run.ts --forge /tmp/forge --hub examples/sandbox --all --data ~/agentgraph-data
```

`--forge` also works with `loop` and `status`; sessions still use Docker and proxy keys. Use a persistent forge folder for lasting work. <!-- code: src/status.ts#needsYou -->

| Forge command | Effect |
| --- | --- |
| `show [n]` | All issues and pull requests, or one timeline and diff |
| `comment <n> <text> [--line <path>:<line>]` | Comment on an issue, pull request or line |
| `issue ... --label <name>` or `label <n> <name>` | Add a label that can trigger a workflow |
| `review <n> changes <text>` or `review <n> approve [text]` | Request changes or approve; preceding line comments accompany the review |
| `merge <n>` | Fast-forward the base, retarget stacked pull requests, close the issue named by the branch suffix; fail if the base has diverged |
| `close <n>` | Close an issue |
| `init <repo> --at <sha>` | Copy only that commit and its history as `main`, hiding later fixes |

Actions use `--as <name>`, the instance owner, or `git config user.name`, and count as a maintainer's.

## Instances

An instance bundles a hub, forge copy, data and optional keys for one repo. The original repo is read only until `export`. <!-- code: src/instance.ts#instanceAt -->

```
~/agentgraph/kit/
  instance.yaml   repo: /path/to/repo, base: main, owner: <you>
  hub/            editable hub copy
  forge/          issues, timelines, origin.git
  data/           runs, traces, mirror
  keys.env        optional KEY=value settings
```

### Set one up

```sh
node bin/forge.ts ~/agentgraph/kit init ~/code/acme-app --hub examples/sandbox --base main
```

`--base` defaults to `main`; workflows targeting another base also set `base`. Convert the generated model keys into `keys.env`, loaded only for variables not already set:

```sh
sed -n 's/^AGENTGRAPH_LLM_API_KEY_\([A-Z_]*\)=\(.*\)$/\1=\2/p' infra/local/.keys.env |
  awk -F= '{ n = tolower($1); gsub("_", "-", n); printf "%s%s=%s", (NR > 1 ? "," : ""), n, $2 }' |
  sed 's/^/AGENTGRAPH_PROXY_KEYS=/' > ~/agentgraph/kit/keys.env
```

### A loop by hand

Both CLIs find an instance from any folder inside it. `run.ts` also searches its working directory when no hub, forge or data flags are given.

```sh
node bin/forge.ts ~/agentgraph/kit issue "Reject a negative count" --body issue.md --label agent:ready
node bin/run.ts --instance ~/agentgraph/kit --all
node bin/forge.ts ~/agentgraph/kit show 2
node bin/forge.ts ~/agentgraph/kit review 2 changes "also cover zero"
node bin/run.ts --instance ~/agentgraph/kit --all
node bin/forge.ts ~/agentgraph/kit review 2 approve
node bin/forge.ts ~/agentgraph/kit merge 2
node bin/forge.ts ~/agentgraph/kit export 2
```

Answer questions with `/agent` comments as [Waiting](loop.md#waiting) describes.

`export <n>` fetches the branch into the original repo without moving its checked-out branch or overwriting divergent work. `export <n> --patch <file>` writes missing commits as a patch without changing the repo. `sync` fast-forwards the instance base from the repo; if both diverged, export and merge in the repo first.

### Several side by side

Each instance has its own mirror and data:

```sh
node bin/run.ts loop --instance ~/agentgraph/kit &
node bin/run.ts loop --instance ~/agentgraph/clarinet &
```

Open one studio per instance, using a different `AGI_PORT` for each.

## The studio

From `studio/`:

```sh
npm install
npm run dev -- --instance ~/agentgraph/kit
```

The default port is 5182, overridden by `AGI_PORT`. Without an instance, `-- --hub <dir> --data <dir>` selects inputs. Otherwise the studio reads `examples/sandbox` and `AGENTGRAPH_DATA`, falling back to `~/.agentgraph`. It only reads hub and run data.

## Before you commit

`npm run precommit` validates example hubs, schema usage, docs refs and name coverage, documented commands, unused code and formatting. It also runs the agentgraph hub's fast checks over uncommitted changes against `HEAD` or `AGENTGRAPH_BASE`. Hub loading rejects retired terms. `npm run verify` runs the full checks, including types, coverage and studio build.

Docs bind claims to code with hidden comments such as `<!-- code: src/engine.ts#land -->`:

```sh
node bin/refs.mjs                    # validate file and symbol references
node bin/refs.mjs --pairs            # list section-symbol pairs
node bin/refs.mjs --diff main        # show the other side needing review
node bin/refs.mjs --coverage         # find undocumented names and uncited exports
```

`--diff HEAD --staged` checks staged changes; precommit prints these warnings. Pairs changed on both sides are omitted; unchanged sections citing the same symbol are included. Coverage requires user-facing fields, values, statuses, labels, proposal kinds, CLI names and `AGENTGRAPH_` variables in docs code spans. Uncited exports are listed only.
