# Running it locally

You need Node 22.18 or later, and Docker for the sandbox. Commands run from the `bothub` directory unless a section says otherwise.

## The model stack

From `infra/local`:

```sh
cp .env.example .env              # set LITELLM_MASTER_KEY and provider keys
docker compose up -d              # LiteLLM and Postgres
docker compose --profile sandbox up -d
docker build -t bothub-sandbox:local sandbox
./keys.sh                         # one virtual key per agent, written to .keys.env
```

`infra/local/README.md` covers the rest, including the ChatGPT login for `smart`.

The first run on a Rust repo spends a few minutes filling the `bothub-cache` volume with its toolchain and crates. Later runs reuse it, see [Toolchains](sandbox.md#toolchains).

## The CLI

```sh
node bin/run.ts check --hub examples/sandbox
node bin/run.ts --hub examples/sandbox --issue 3 --data /tmp/bothub-data
node bin/run.ts --hub examples/sandbox --all --data /tmp/bothub-data
node bin/run.ts loop --hub examples/sandbox --data /tmp/bothub-data
node bin/run.ts status --hub examples/sandbox --data /tmp/bothub-data
```

- `check` loads a hub and prints every problem with its file, or `ok`.
- `--issue <n>` looks at one issue once. It continues a waiting run a human has answered, or begins one when none is live, and drives it until it waits or ends. It prints one line per run: id, step, status and reason.
- `--all` does the same for every open issue, up to `limits.parallel` issues at once. It begins a run only where a trusted command or label asks for one.
- `loop` looks at the repo every `BOTHUB_EVERY` minutes until it is stopped. Without `--hub`, it reads the hub from `.bothub/` in the repo, and `BOTHUB_REPO` names the repo, see [A hub in the repo](loop.md#a-hub-in-the-repo). <!-- code: src/main.ts#start -->
- `status` lists what waits on a human. It also warns when the App's installation reaches repos besides the hub's, and needs the App's credentials.

`--hub <dir>` names a hub folder on this machine, `--data <dir>` the data dir, and `--forge <dir>` a forge folder to use instead of GitHub. `--instance <dir>` stands for all three, see [Instances](#instances). The repo comes from `repo` in `hub.yaml`. The CLI hands these to the runner as `BOTHUB_HUB`, `BOTHUB_DATA`, `BOTHUB_FORGE` and `BOTHUB_REPO`. The runner also reads:

| Variable              | What it is                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| `BOTHUB_APP_ENV`      | An env file with the GitHub App's `BOTHUB_APP_ID` and `BOTHUB_APP_KEY`                               |
| `BOTHUB_APP_KEY_FILE` | In that file, a path to the App's private key, read in as `BOTHUB_APP_KEY`                           |
| `BOTHUB_EVERY`        | Minutes between looks in `loop`, 5 by default                                                        |
| `BOTHUB_PROXY_URL`    | The model proxy, `http://litellm:4000/v1` by default                                                 |
| `BOTHUB_PROXY_KEYS`   | The agents' model keys, see [Models](sandbox.md#models)                                              |
| `BOTHUB_PRICES`       | The list prices file, `infra/local/prices.json` by default                                           |
| `BOTHUB_CHECK_LOGS`   | Which check output the data dir keeps: `all` by default, `failed` or `off`                           |
| `BOTHUB_CACHE_VOLUME` | The docker volume for [toolchains](sandbox.md#toolchains), `bothub-cache` by default; empty for none |

The App's variables can also be set in the environment directly. `--logs` on the CLI, or `logs` in `instance.yaml`, sets `BOTHUB_CHECK_LOGS`. <!-- code: src/services.ts#settings -->

## Without GitHub

A forge folder stands in for the GitHub repo, and `bin/forge.ts` plays the maintainer on it. No GitHub App is needed. <!-- code: src/forge.ts#fileForge -->

```
/tmp/forge/
  <n>.md          an issue
  <n>.jsonl       its timeline
  <n>/            a pull request: pull.json and diff.patch
  origin.git      the bare repo that holds the branches
```

```sh
node bin/forge.ts /tmp/forge init ../path/to/repo         # copies the repo into /tmp/forge/origin.git
node bin/forge.ts /tmp/forge issue "Reject a negative count" --body issue.md
node bin/forge.ts /tmp/forge comment 1 /bothub
node bin/run.ts --forge /tmp/forge --hub examples/sandbox --all --data /tmp/bothub-data
node bin/forge.ts /tmp/forge show                         # every issue and pull request
node bin/forge.ts /tmp/forge show 2                       # one, with its timeline and diff
node bin/forge.ts /tmp/forge comment 2 "/bothub also cover zero"
node bin/run.ts --forge /tmp/forge --hub examples/sandbox --all --data /tmp/bothub-data
node bin/forge.ts /tmp/forge merge 2
node bin/run.ts --forge /tmp/forge --hub examples/sandbox --issue 1 --data /tmp/bothub-data
```

- Comments, labels and issues are by `git config user.name`, or by `--as <name>`, and count as a maintainer's.
- `issue --label <name>` labels a new issue, and `label <n> <name>` labels one later, so a labelled workflow like triage starts.
- `merge <n>` fast-forwards the base branch to the pull request's head and marks it merged. Pull requests stacked on it move to its base, and the issue named at the end of its branch closes (`bothub/1` closes #1). It fails when the base has moved past the pull request.
- `close <n>` closes an issue.
- `init <repo> --at <sha>` puts only that commit and its history in `origin.git`, as `main`, so a replayed task cannot find its own fix.

Agents still run in the Docker sandbox with `BOTHUB_PROXY_KEYS`. `--forge` works with `loop` and `status` too, and `status` then needs no App. <!-- code: src/status.ts#needsYou -->

## Instances

An instance lets you work on a repo through bothub without touching it. It is one folder that holds the hub, a forge folder over a copy of the repo, the data dir and the model keys. Keep as many as you like under one root, one folder per repo. <!-- code: src/instance.ts#instanceAt -->

```
~/bothub/
  kit/
    instance.yaml   repo: /path/to/repo, base: main, owner: <you>
    hub/            the hub, as .bothub/ would hold it
    forge/          the forge folder, with origin.git
    data/           runs, traces and the sandbox mirror
    keys.env        optional KEY=value lines, such as BOTHUB_PROXY_KEYS
  clarinet/
    ...
```

The repo is only read. `init` copies it into `forge/origin.git`, and every branch, push and merge lands there. Nothing reaches the repo until you run `export`.

### Set one up

```sh
node bin/forge.ts ~/bothub/kit init ~/code/acme-app --hub examples/sandbox --base main
```

`--hub` copies a hub into `hub/`, where you edit it in place. `--base` names the branch pull requests go into, `main` by default; a workflow on another base sets `base:` too. The owner is `git config user.name`, or `--as <name>`, and everything you do as the owner counts as a maintainer's.

For the model keys, put the agents' keys in `keys.env`. `run.ts` loads it when the variables are not set already:

```sh
sed -n 's/^BOTHUB_LLM_API_KEY_\([A-Z_]*\)=\(.*\)$/\1=\2/p' infra/local/.keys.env |
  awk -F= '{ n = tolower($1); gsub("_", "-", n); printf "%s%s=%s", (NR > 1 ? "," : ""), n, $2 }' |
  sed 's/^/BOTHUB_PROXY_KEYS=/' > ~/bothub/kit/keys.env
```

### A loop by hand

`bin/forge.ts` and `bin/run.ts` take the instance folder, or any folder inside it. `run.ts` also finds it from the working directory when you pass no `--hub`, `--forge` or `--data`.

```sh
node bin/forge.ts ~/bothub/kit issue "Reject a negative count" --body issue.md --label agent:ready
node bin/run.ts --instance ~/bothub/kit --all
node bin/forge.ts ~/bothub/kit show                  # issues and pull requests
node bin/forge.ts ~/bothub/kit show 2                # one thread, with the diff
node bin/forge.ts ~/bothub/kit comment 2 "count zero as valid" --line src/math.js:12
node bin/forge.ts ~/bothub/kit review 2 changes "also cover zero"
node bin/run.ts --instance ~/bothub/kit --all
node bin/forge.ts ~/bothub/kit comment 1 "zero is valid"   # answers a question the run asked
node bin/run.ts --instance ~/bothub/kit --issue 1
node bin/forge.ts ~/bothub/kit review 2 approve
node bin/forge.ts ~/bothub/kit merge 2
node bin/forge.ts ~/bothub/kit export 2
```

- `review <n> changes <text>` requests changes on a pull request, and `review <n> approve [text]` approves it. Line comments made with `comment <n> <text> --line <path>:<line>` reach the run with the review.
- `run.ts status --instance <dir>` lists what waits on you, with the command to go on.
- `export <n>` fetches the pull request's branch into the repo as a branch of the same name. It never moves the checked-out branch and fails rather than overwrite a branch that went elsewhere. `export <n> --patch <file>` writes the commits the repo's base lacks as a patch instead, and writes nothing to the repo.
- `sync` brings new commits on the repo's base into the instance. It fails when both have moved; export and merge on the repo first.

Everything else, `label`, `close` and `--as`, works as on a forge folder.

### Several side by side

Each instance has its own data dir and mirror, so run one `loop` per instance:

```sh
node bin/run.ts loop --instance ~/bothub/kit &
node bin/run.ts loop --instance ~/bothub/clarinet &
```

The studio shows one instance at a time: `npm run dev -- --instance ~/bothub/kit` from `studio/`, with `BHM_PORT` set to a free port for a second one.

A hub on GitHub works the same way with the App, see [The loop](loop.md). The engine is the same; only the forge differs.

## The studio

From `studio/`:

```sh
npm install
npm run dev
```

It starts on http://localhost:5182, or on `BHM_PORT`. `-- --instance <dir>` shows an instance. Without `-- --hub <dir> --data <dir>` it shows `examples/acme-app` and `BOTHUB_DATA`, or `~/.bothub`. It only reads the hub and the data dir.

## Before you commit

`npm run precommit` checks every example hub, the schema fields, the docs code refs and their coverage, the commands and flags that docs and usage headers name, unused code and formatting. Loading a hub also refuses a short list of retired words, such as answering with a command. Then it runs the bothub hub's fast checks over the uncommitted change, against `HEAD` or `BOTHUB_BASE`. `npx tsc --noEmit` and `npx vitest run --testTimeout=60000` cover the code.

A docs sentence that a symbol backs is followed by an HTML comment like `<!-- code: src/engine.ts#land -->`, which readers never see. `bin/refs.mjs` pairs each docs section with the symbols it cites, so either side can be checked when the other changes.

```sh
node bin/refs.mjs                    # every ref names a file and a top-level symbol in it
node bin/refs.mjs --pairs            # every docs section with the symbols it cites
node bin/refs.mjs --diff main        # the other side of each pair to re-check after the change
node bin/refs.mjs --coverage         # what no docs page names
```

`--diff` prints `code changed: <symbol> is cited by <section>` when a change touches a cited symbol, and `docs changed: <section> cites <symbol>` when it touches a section with refs, plus every other section that cites the same symbol. A pair that changed on both sides is left out. `--diff HEAD --staged` reads the staged change, and `npm run precommit` prints it as a warning.

`--coverage` fails when a user-facing name appears in no docs page as code: hub file fields and values, proposal kinds and fields, run statuses and status labels, CLI commands and flags, and `BOTHUB_` variables. It only lists exports in `src` without a ref.
