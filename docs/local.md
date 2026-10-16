# Running it locally

Commands to check a hub, look at an issue and open the studio.

You need Node 22.18 or later, and Docker for the sandbox. Commands run from the `bothub` directory.

## The CLI

```sh
node core/bin/run.ts check --hub examples/sandbox
node core/bin/run.ts --hub examples/sandbox --issue 3 --data /tmp/bothub-data
node core/bin/run.ts --hub examples/sandbox --all --data /tmp/bothub-data
node core/bin/run.ts status --hub examples/sandbox --data /tmp/bothub-data
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
`--issue` or `--all`, `core/src/main.ts` looks at the repo every `BOTHUB_EVERY` minutes, 5 by default.

## The studio

From `studio/`:

```sh
npm install
npm run dev
```

The API starts on port 5181 and the app on http://localhost:5182. Pass `-- --hub <dir> --data <dir>`
to point it elsewhere. The graph page draws each workflow as its steps, with the number of checks
and tries on each card, and shows which step a run is on. The runs page lists runs and the ones
waiting on a human. Hub files are edited in an editor; the studio only reads them.

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

`npm run precommit` runs the core hub check, the core format check and the bothub hub's own fast
checks over the uncommitted change, against `HEAD` or `BOTHUB_BASE`. `npx tsc --noEmit` and
`npx vitest run --testTimeout=60000` cover the code.
