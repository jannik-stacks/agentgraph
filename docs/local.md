# Running it locally

You need Node 22.18 or later, and Docker for the sandbox. Commands run from the `bothub` directory.

## The CLI

```sh
node bin/run.ts check --hub examples/sandbox
node bin/run.ts --hub examples/sandbox --issue 3 --data /tmp/bothub-data
node bin/run.ts --hub examples/sandbox --all --data /tmp/bothub-data
node bin/run.ts status --hub examples/sandbox --data /tmp/bothub-data
```

- `check` loads a hub and prints every problem with its file, or `ok`.
- `--issue <n>` looks at one issue once. It continues a run that is waiting when a human has
  answered, begins a run when none is live, and drives it until it waits or ends. It prints one
  line per run: id, step, status and the reason.
- `--all` does the same for every open issue that has never had a run.
- `status` lists what waits on a human, with the command that continues each run. It needs
  `BOTHUB_APP_ENV`.

Besides the flags, the runner reads `BOTHUB_REPO` (the repo), `BOTHUB_APP_ENV` (the GitHub App env
file) and `BOTHUB_PROXY_KEYS` (the agents' model keys, see [Sandbox](sandbox.md)). Started without
`--issue` or `--all`, the runner looks at the repo every `BOTHUB_EVERY` minutes, 5 by default (`code: src/main.ts#start`).

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
- The agents still run in the Docker sandbox with `BOTHUB_PROXY_KEYS`, as on GitHub. `--forge` also
  works with `loop`; `status` still needs the App.

## The studio

From `studio/`:

```sh
npm install
npm run dev
```

The app starts on http://localhost:5182. Pass `-- --hub <dir> --data <dir>`
to point it elsewhere. The graph page draws each workflow as its steps, with the number of checks
and tries on each card, and shows which step a run is on. The runs page lists runs and the ones
waiting on a human. The studio only reads hub files.

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

`npm run precommit` runs the hub check, the format check and the bothub hub's own fast
checks over the uncommitted change, against `HEAD` or `BOTHUB_BASE`. `npx tsc --noEmit` and
`npx vitest run --testTimeout=60000` cover the code.
