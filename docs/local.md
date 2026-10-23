# Running it locally

You need Node 22.18 or later, Docker and `jq`. Commands run from `agentgraph/`.

## The model stack

```sh
cp infra/local/.env.example infra/local/.env   # once: set LITELLM_MASTER_KEY and provider keys
npm run up                                     # sandbox image, proxy and egress, waits until healthy
npm run keys                                   # one proxy key per agent, in infra/local/.keys.env
```

Runs need the stack up. `npm run down` stops it and keeps its volumes.

[Local infrastructure](../infra/local/README.md) covers providers, the ChatGPT login for `smart` and moving a stack from the old `bothub` compose project.

## The CLI

```sh
npx agentgraph check --hub examples/sandbox
npx agentgraph --hub examples/sandbox --issue 3 --data ~/agentgraph-data
npx agentgraph --hub examples/sandbox --all --data ~/agentgraph-data
npx agentgraph loop --hub examples/sandbox --data ~/agentgraph-data
npx agentgraph status --hub examples/sandbox --data ~/agentgraph-data
npx agentgraph prune-logs --data ~/agentgraph-data [--apply]
```

| Command | What it does |
| --- | --- |
| `check` | Validates a hub and prints each problem with its file, or `ok`. Needs no model or container. |
| `--issue <n>` | Starts or resumes one issue's run and drives it until it waits or ends. |
| `--all` | One pass over open issues. Starts runs only on trusted commands or labels, up to `limits.parallel` at once. |
| `loop` | A pass at startup, then every `AGENTGRAPH_EVERY` minutes. Without `--hub` it uses the repo's [own hub](loop.md#a-hub-in-the-repo) and `AGENTGRAPH_REPO`. |
| `status` | Lists human waits and the commands to continue them. On GitHub it needs App credentials and warns when the App reaches other repos. |
| `prune-logs` | Counts [check logs](runs.md#check-logs) no trace names; `--apply` deletes them. |

`--hub`, `--data` and `--forge` select folders. `--forge` replaces GitHub with a [forge folder](#without-github). `--instance` supplies all three. Outside an instance, every command but `check` needs `--data`. Keep data out of temporary directories, since macOS deletes untouched files there after three days; startup warns about it. <!-- code: src/main.ts#start src/main.ts#temporary -->

Three commands talk to a run the way [router proposals](loop.md#routing) do:

```sh
npx agentgraph say --hub <dir> --data <dir> --issue <n> [--comment <review comment id>] "<text>"
npx agentgraph tell --data <dir> --issue <n> "<text>"
npx agentgraph dispatch --hub <dir> --data <dir> --workflow <name> --issue <n> [--step <step>]
```

`say` runs the router now and replies where the text came from. `tell` queues text for a live run and refuses when there is none. `dispatch` starts a workflow that accepts `dispatch`.

### Settings

The runner reads these from the environment. The CLI sets `AGENTGRAPH_HUB`, `AGENTGRAPH_DATA`, `AGENTGRAPH_FORGE` and `AGENTGRAPH_REPO` (the hub's `repo`) from its flags. <!-- code: src/services.ts#settings -->

| Variable | Meaning and default |
| --- | --- |
| `AGENTGRAPH_APP_ENV` | Env file with `AGENTGRAPH_APP_ID` and `AGENTGRAPH_APP_KEY_FILE`, the path of the App's private key |
| `AGENTGRAPH_APP_ID`, `AGENTGRAPH_APP_KEY` | The App id and private key, when set directly instead |
| `AGENTGRAPH_EVERY` | Poll interval in minutes, 5 |
| `AGENTGRAPH_PROXY_URL` | Model proxy, `http://litellm:4000/v1` |
| `AGENTGRAPH_PROXY_KEYS` | Per-agent keys, see [Models](sandbox.md#models) |
| `AGENTGRAPH_PRICES` | List prices, `infra/local/prices.json` |
| `AGENTGRAPH_CHECK_LOGS` | `all`, `failed` or `off`, also set by `--logs`; see [Check logs](runs.md#check-logs) |
| `AGENTGRAPH_CACHE_VOLUME` | [Toolchain cache](sandbox.md#toolchains) volume, `agentgraph-cache` |
| `AGENTGRAPH_IMAGE` | Base image when the hub sets none, `agentgraph-sandbox:local` |
| `AGENTGRAPH_STUDIO_URL` | Studio address for [provenance links](runs.md#provenance) |

Disk and cache limits are in [Environments](sandbox.md#environments).

## On GitHub

Create the App with `node bin/setup-app.ts` ([App setup](../infra/github/README.md)) and point `AGENTGRAPH_APP_ENV` at its `app.env`. Then prepare a data directory:

```sh
infra/local/e2e.sh ~/agentgraph-data examples/sandbox
```

It writes the agent keys as `AGENTGRAPH_PROXY_KEYS` to `~/agentgraph-data/.env` and prints the commands to run. The runner does not load that file, so source it first.

## Without GitHub

A forge folder stands in for GitHub and needs no App. It holds `<n>.md` issues, `<n>.jsonl` timelines, `<n>/pull.json` and `diff.patch` for pull requests, and a bare `origin.git`. Sessions still need Docker and proxy keys. <!-- code: src/forge.ts#fileForge src/status.ts#needsYou -->

```sh
node bin/forge.ts ~/forge init ../path/to/repo
node bin/forge.ts ~/forge issue "Reject a negative count" --body issue.md
node bin/forge.ts ~/forge comment 1 /agent
npx agentgraph --forge ~/forge --hub examples/sandbox --all --data ~/agentgraph-data
```

| Forge command | Effect |
| --- | --- |
| `show [n]` | Every issue and pull request, or one timeline and diff |
| `comment <n> <text> [--line <path>:<line>]` | Comment on an issue, a pull request or a line |
| `issue ... --label <name>`, `label <n> <name>` | Add a label, which can start a workflow |
| `review <n> changes <text>`, `review <n> approve [text]` | Request changes or approve; earlier line comments join the review |
| `merge <n>` | Fast-forward the base, retarget stacked pull requests and close the issue the branch names; fails if the base moved |
| `close <n>` | Close an issue |
| `init <repo> --at <sha>` | Copy only that commit and its history as `main`, hiding later fixes |

Actions run as `--as <name>`, the instance owner or `git config user.name`, and count as a maintainer's.

## Instances

An instance bundles a hub copy, a forge, data and optional keys for one repo. Your repo stays untouched until you `export`. Both CLIs find the instance around the working directory when no hub, forge or data flag is given. <!-- code: src/instance.ts#instanceAt -->

```
~/agentgraph/kit/
  instance.yaml   repo, base and owner, see Hub files
  hub/            editable hub copy
  forge/          issues, timelines, origin.git
  data/           runs, traces, mirror
  keys.env        optional KEY=value settings
```

### Set one up

```sh
node bin/forge.ts ~/agentgraph/kit init ~/code/acme-app --hub examples/sandbox --base main
```

`examples/sandbox` is written for its own small JavaScript package: its checks run `npm test` and its prompts name its files. For another repo, edit the hub copy in `hub/` first: `setup`, the checks and the skills. `check --hub ~/agentgraph/kit/hub` validates it.

Then turn the proxy keys into `keys.env`. Its values apply only where the environment has none.

```sh
sed -n 's/^AGENTGRAPH_LLM_API_KEY_\([A-Z0-9_]*\)=\(.*\)$/\1=\2/p' infra/local/.keys.env |
  awk '{ i = index($0, "="); n = tolower(substr($0, 1, i - 1)); gsub("_", "-", n); printf "%s%s=%s", sep, n, substr($0, i + 1); sep = "," }' |
  sed 's/^/AGENTGRAPH_PROXY_KEYS=/' > ~/agentgraph/kit/keys.env
```

### A loop by hand

```sh
node bin/forge.ts ~/agentgraph/kit issue "Reject a negative count" --body issue.md --label agent:ready
npx agentgraph --instance ~/agentgraph/kit --all
node bin/forge.ts ~/agentgraph/kit show 2
node bin/forge.ts ~/agentgraph/kit review 2 changes "also cover zero"
npx agentgraph --instance ~/agentgraph/kit --all
node bin/forge.ts ~/agentgraph/kit review 2 approve
node bin/forge.ts ~/agentgraph/kit merge 2
node bin/forge.ts ~/agentgraph/kit export 2
```

Answer questions with `/agent` comments, as [Waiting](loop.md#waiting) describes.

`export <n>` fetches the branch into your repo without moving its checked-out branch or overwriting work. `export <n> --patch <file>` writes the missing commits as a patch instead. `sync` fast-forwards the instance base from your repo; if both moved, export and merge in your repo first.

Several instances run side by side, each with its own mirror and data:

```sh
npx agentgraph loop --instance ~/agentgraph/kit &
npx agentgraph loop --instance ~/agentgraph/clarinet &
```

## The studio

From `studio/`:

```sh
npm install
npm run dev -- --instance ~/agentgraph/kit
```

It serves on port 5182, or `AGI_PORT`; give each instance its own port. Instead of `--instance`, `--hub <dir> --data <dir>` select the inputs. Without either it reads `examples/sandbox` and `AGENTGRAPH_DATA`, else `~/.agentgraph`. `npm run dev -- --bench <dirs>` fills the [Bench](bench.md#cost-against-quality) tab, and `npm run dev -- --tune <dir>` the Compound tab. The studio only reads.
