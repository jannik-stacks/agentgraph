# Running it locally

Commands to validate a hub, dry-run it and open BHM.

You need Node 22.18 or later. Commands run from the `bothub` directory unless noted.

## The CLI

```sh
bin/bothub.mjs check --dir examples/acme-app
bin/bothub.mjs run --event issue_comment examples/payloads/issue-comment.json --dir examples/hub --dry-run
bin/bothub.mjs logs
bin/bothub.mjs logs <run id> --follow
```

- `check` compiles a hub and prints every error, and warns about checks no job uses.
- `run` runs the jobs a webhook payload starts on this machine. `--dry-run` lists them with each
  agent session instead of starting them.
- `logs` lists runs, newest first, and with a run id prints that run's events. `--follow` keeps printing until the run ends, and `--spend`
  compares the recorded model calls with the proxy's spend logs.
- `mcp` serves a hub's tools over MCP on stdio. `--help` does not list it.
- `serve` runs a hub's events and serves the studio API: a hub with `issues: local` watches its
  issue files (`serveHub`), any other receives GitHub App webhooks
  (`serveGitHub`). Before it starts, it asks each model endpoint the bots use whether
  it takes their key (`preflight`), and refuses to start when one is refused, naming
  the bots and the variable. `sim` runs a scenario without a model (`simulate`).
  See [Events and serving](reference/serve.md).

Add `--json` for machine-readable output; it is the default when stdout is not a terminal. `--data` points at a data directory
other than `$BOTHUB_DATA` or `~/.bothub`.

## BHM

From `studio/`:

```sh
npm install
npm run dev
npm run seed
```

`npm run dev` starts the API on port 5181 and the app on http://localhost:5182, pointed at the
acme-app example hub. Pass `-- --hub <dir> --data <dir>` to point it elsewhere. `npm run seed`
writes a few sample runs into the data directory so the runs page has something to show; add
`-- --live` to stream one slowly. The API restarts by itself when files under `src/` change. If it
runs code older than `src/` anyway, BHM shows a banner until the API catches up.

## Before you commit

Run `npm run verify` from the `bothub` directory. It stops at the first failure and runs, in order:

- `oxfmt --check` over `src`, `tests`, `bin` and `studio`. Test fixtures are left alone, since
  tests depend on their line numbers.
- `oxlint`, then `tsc --noEmit` for bothub and for studio.
- `vitest run --coverage` with the coverage thresholds. Besides the unit tests this checks that
  every API path studio fetches is served, every docs link resolves, every route has a nav
  entry, every example hub compiles, and every acme-app bot's
  model is served by LiteLLM and allowed by its key in `keys.sh`. The run fails if a test leaves
  a process running.
- The studio build.
- `bothub check` on every hub under `examples/`.

`npm run precommit` runs the bothub hub's own size, rules, unused-exports and propagation scripts
over the uncommitted change, against `HEAD` or `BOTHUB_BASE`, and fails on a finding of a gating one.

## The graph

The graph page draws each workflow as its steps, with a trigger on the left and the number of checks
and tries on each card. Selecting a step shows its bot, its checks and its latest runs. A step
that has a run going shows it on the card: running, waiting or failed. Hub files are edited in an
editor or through a bot's hub proposal; the studio only reads them.

## The model stack

From `infra/local`:

```sh
cp .env.example .env              # set LITELLM_MASTER_KEY and provider keys
ollama pull qwen3.5:4b
ollama pull tev1:0.8b
docker compose up -d              # LiteLLM and Postgres
docker compose --profile sandbox up -d
docker build -t bothub-sandbox:local sandbox
./keys.sh                         # one virtual key per bot, written to .keys.env
```

Copy the `BOTHUB_LLM_API_KEY_<BOT>` lines from `.keys.env` into `$BOTHUB_DATA/.env`, then point
bothub at the proxy with `BOTHUB_LLM_BASE_URL=http://127.0.0.1:4000/v1`. The ChatGPT login for
`smart` and `writer` runs once from the CLI; `infra/local/README.md` has the steps.

`docker compose --profile sandbox --profile ollama down` stops everything and
keeps the volumes.
