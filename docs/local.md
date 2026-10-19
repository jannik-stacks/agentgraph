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
- `--all` does the same for every open issue, one after another. It begins a run only where a trusted command or label asks for one.
- `loop` looks at the repo every `BOTHUB_EVERY` minutes until it is stopped (`code: src/main.ts#start`).
- `status` lists what waits on a human. It also warns when the App's installation reaches repos besides the hub's, and needs the App's credentials.

`--hub <dir>` names the hub, `--data <dir>` the data dir, and `--forge <dir>` a forge folder to use instead of GitHub. The repo comes from `repo` in `hub.yaml`. The CLI hands these to the runner as `BOTHUB_HUB`, `BOTHUB_DATA`, `BOTHUB_FORGE` and `BOTHUB_REPO`. The runner also reads:

| Variable              | What it is                                                                       |
| --------------------- | -------------------------------------------------------------------------------- |
| `BOTHUB_APP_ENV`      | An env file with the GitHub App's `BOTHUB_APP_ID` and `BOTHUB_APP_KEY`           |
| `BOTHUB_APP_KEY_FILE` | In that file, a path to the App's private key, read in as `BOTHUB_APP_KEY`       |
| `BOTHUB_EVERY`        | Minutes between looks in `loop`, 5 by default                                    |
| `BOTHUB_PROXY_URL`    | The model proxy, `http://litellm:4000/v1` by default                             |
| `BOTHUB_PROXY_KEYS`   | The agents' model keys, see [Models](sandbox.md#models)                          |
| `BOTHUB_PRICES`       | The list prices file, `infra/local/prices.json` by default                       |

The App's variables can also be set in the environment directly (`code: src/services.ts#settings`).

## Without GitHub

A forge folder stands in for the GitHub repo, and `bin/forge.ts` plays the maintainer on it. No GitHub App is needed (`code: src/forge.ts#fileForge`).

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

Agents still run in the Docker sandbox with `BOTHUB_PROXY_KEYS`. `--forge` works with `loop` too, while `status` still needs the App.

## The studio

From `studio/`:

```sh
npm install
npm run dev
```

It starts on http://localhost:5182, or on `BHM_PORT`. Without `-- --hub <dir> --data <dir>` it shows `examples/acme-app` and `BOTHUB_DATA`, or `~/.bothub`. It only reads the hub and the data dir.

## Before you commit

`npm run precommit` checks every example hub, the schema fields, the docs code refs and their coverage, unused code and formatting. Then it runs the bothub hub's fast checks over the uncommitted change, against `HEAD` or `BOTHUB_BASE`. `npx tsc --noEmit` and `npx vitest run --testTimeout=60000` cover the code.

A docs sentence that a symbol backs ends with a ref like `code: src/engine.ts#land`. `bin/refs.mjs` pairs each docs section with the symbols it cites, so either side can be checked when the other changes.

```sh
node bin/refs.mjs                    # every ref names a file and a top-level symbol in it
node bin/refs.mjs --pairs            # every docs section with the symbols it cites
node bin/refs.mjs --diff main        # the pairs whose other side to re-check after the change
node bin/refs.mjs --coverage         # what no docs page names
```

`--diff` prints `code changed: <symbol> is cited by <section>` when a change touches a cited symbol, and `docs changed: <section> cites <symbol>` when it touches a section with refs.

`--coverage` fails when a user-facing name appears in no docs page as code: hub file fields and values, proposal kinds and fields, run statuses and status labels, CLI commands and flags, and `BOTHUB_` variables. It only lists exports in `src` without a ref.
