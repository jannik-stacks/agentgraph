# Running it locally

You need Node 22.18 or later, and Docker for the sandbox. Commands run from the `bothub` directory.

## The CLI

```sh
node bin/run.ts check --hub examples/sandbox
node bin/run.ts --hub examples/sandbox --issue 3 --data /tmp/bothub-data
node bin/run.ts --hub examples/sandbox --all --data /tmp/bothub-data
node bin/run.ts loop --hub examples/sandbox --data /tmp/bothub-data
node bin/run.ts status --hub examples/sandbox --data /tmp/bothub-data
```

- `check` loads a hub and prints every problem with its file, or `ok`.
- `--issue <n>` looks at one issue once. It continues a run that is waiting when a human has
  answered, begins a run when none is live, and drives it until it waits or ends. It prints one
  line per run: id, step, status and the reason.
- `--all` looks at every open issue once, one after another. It continues and drives live runs,
  and begins a run only where a collaborator's command or label asks for one.
- `loop` looks at the repo every `BOTHUB_EVERY` minutes, 5 by default, until it is stopped
  (`code: src/main.ts#start`).
- `status` lists what waits on a human, with the command that continues each run. It also warns
  when the App's installation reaches repos besides the hub's. It needs the App's credentials.
- `--hub <dir>` names the hub and `--data <dir>` the data dir. `--forge <dir>` runs on a forge folder
  instead of GitHub, see [Without GitHub](local.md#without-github).

The repo is `repo` in the hub's `hub.yaml`. The CLI hands it to the runner as `BOTHUB_REPO`, with
`--hub` as `BOTHUB_HUB` and `--data` as `BOTHUB_DATA`. The runner also reads:

| Variable              | What it is                                                                   |
| --------------------- | ---------------------------------------------------------------------------- |
| `BOTHUB_APP_ENV`      | An env file with the GitHub App's `BOTHUB_APP_ID` and `BOTHUB_APP_KEY`       |
| `BOTHUB_APP_KEY_FILE` | In that file, a path to the App's private key, read in as `BOTHUB_APP_KEY`   |
| `BOTHUB_PROXY_URL`    | The model proxy, `http://litellm:4000/v1` by default                         |
| `BOTHUB_PROXY_KEYS`   | The agents' model keys, see [Sandbox](sandbox.md)                            |
| `BOTHUB_PRICES`       | The list prices file, `infra/local/prices.json` by default                   |
| `BOTHUB_EVERY`        | Minutes between looks in `loop`                                              |
| `BOTHUB_FORGE`        | A forge folder to use instead of GitHub; `--forge` sets it                   |

The App's variables can also be set in the environment directly (`code: src/services.ts#settings`).

## Without GitHub

A forge folder stands in for the GitHub repo, and `bin/forge.ts` plays the maintainer on it. No
GitHub App is needed. Issues are `<n>.md` files, their timelines `<n>.jsonl`, and a pull request is a
folder `<n>/` with `pull.json` and `diff.patch` (`code: src/forge.ts#fileForge`). Branches live in
the bare repo `origin.git` inside the folder.

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

- Comments, labels and issues are by `git config user.name`, or by `--as <name>`, and count as a
  maintainer's.
- `issue` takes `--label <name>` too, and `label <n> <name>` adds one later, so a labelled workflow
  like triage starts.
- `merge <n>` fast-forwards the base branch in `origin.git` to the pull request's head, marks it
  merged, moves pull requests stacked on it to its base, and closes the issue named at the end of
  its branch (`bothub/1` closes #1). It fails when the base has moved past the pull request.
- `close <n>` closes an issue.
- `init <repo> --at <sha>` puts only that commit and its history in `origin.git`, as `main`. Later
  commits are not in it, so a replayed task cannot find its own fix.
- The agents still run in the Docker sandbox with `BOTHUB_PROXY_KEYS`, as on GitHub. `--forge` also
  works with `loop`; `status` still needs the App.

## The studio

From `studio/`:

```sh
npm install
npm run dev
```

The app starts on http://localhost:5182. Pass `-- --hub <dir> --data <dir>`
to point it elsewhere; without them it shows `examples/acme-app` and `BOTHUB_DATA`, or `~/.bothub`.
Set `BHM_PORT` for another port. The graph page draws each workflow as its steps, with the number of
checks and tries on each card, and shows which step a run is on. The runs page lists runs and the
ones waiting on a human. The studio only reads the hub and the data dir.

## The model stack

From `infra/local`:

```sh
cp .env.example .env              # set LITELLM_MASTER_KEY and provider keys
docker compose up -d              # LiteLLM and Postgres
docker compose --profile sandbox up -d
docker build -t bothub-sandbox:local sandbox
./keys.sh                         # one virtual key per agent, written to .keys.env
```

`infra/local/README.md` has the rest, including the ChatGPT login for `smart`.

## Before you commit

`npm run precommit` checks every example hub, the schema fields, the docs code refs and coverage,
unused code and formatting, then runs the bothub hub's own fast checks over the uncommitted change,
against `HEAD` or `BOTHUB_BASE`. See [Docs and code](local.md#docs-and-code). `npx tsc --noEmit` and
`npx vitest run --testTimeout=60000` cover the code.

## Docs and code

A docs sentence that a symbol backs ends with a ref like `code: src/engine.ts#land`. `bin/refs.mjs`
turns those refs into pairs of a docs section and a symbol, so each side can be checked when the
other changes.

```sh
node bin/refs.mjs                    # every ref names a file and a top-level symbol in it
node bin/refs.mjs --pairs            # every docs section with the symbols it cites
node bin/refs.mjs --diff main        # the pairs whose other side to re-check after the change
node bin/refs.mjs --coverage         # what no docs page names
```

`--diff` prints `code changed: <symbol> is cited by <section>` when a change touches a cited
symbol, and `docs changed: <section> cites <symbol>` when it touches a section with refs.

`--coverage` fails on user-facing names no docs page shows in code: the hub, agent, check,
workflow and step fields and their values, proposal kinds and fields, run statuses and status
labels, CLI commands and flags, and `BOTHUB_` variables. Exports in `src` without a ref are only
listed.
