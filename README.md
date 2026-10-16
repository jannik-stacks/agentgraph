# bothub

bothub is an agent hub. Scripts slice the work, and many narrow
agents each judge one piece. A hub is the config: agents, skills, checks, workflows and notes, all Markdown
files with YAML frontmatter. See `docs/index.md` for how a change reaches the repository.

Needs Node 22.18 or later, and Docker for the sandbox.

## Commands

Run them as `node bin/bothub.mjs <command>`, or `bothub <command>` once installed.

- `check` validates a hub (bots, skills, checks, workflows, notes) and fails closed.
- `run` runs the jobs a GitHub webhook payload starts, on this machine. `--dry-run` only lists them.
- `serve` runs a hub's events and serves the studio API: local issues for a hub with
  `issues: local`, GitHub App webhooks otherwise.
- `logs` lists runs, or prints one run's events. `--follow` tails it, `--spend` compares recorded
  model calls with the proxy's spend logs.
- `sim` plays a scenario end to end on a temporary copy of a hub, with scripted bots.
- `mcp` serves a hub's tools over MCP on stdio.

Each command takes `--help`.

## What a bot loads from the repo

A bot's harness can load the target repo's own instructions and skills. `loads` lists what: `instructions`
(AGENTS.md and CLAUDE.md, once when they are the same text), `skills` or `skills/<name>`. The default is
`[instructions, skills]`; set it in `hub.yaml` for all bots or in a bot file for one. A named skill missing from the
repo fails the run. A hub skill of the same name wins, and the run record marks the repo one as shadowed. Repo guidance
is advice: the job's skill and the bot's role win where they conflict. `tools` and `mcp` entries, which would run the
repo's own code, are accepted by the schema but no harness supports them yet, so `check` fails on them. The repo's
project config never applies: its permissions, models and providers stay ours. A job that changes AGENTS.md,
CLAUDE.md, `.agents/` or `.claude/` fails unless the issue names the file. `check` also fails a `context: resume` on
a harness that cannot continue sessions. Each run records everything it loaded, hub and repo, in `loaded`.

## Local quickstart

1. Validate a hub, which needs no model or container.

   ```sh
   node core/bin/run.ts check --hub examples/acme-app
   ```

2. Start the model proxy. LiteLLM runs in front of every model. In `infra/local`, copy
   `.env.example` to `.env`, set `LITELLM_MASTER_KEY` and your provider keys, then:

   ```sh
   docker compose up -d
   ./keys.sh
   ```

   `keys.sh` creates one virtual key per bot in `.keys.env`. Copy those lines into
   `$BOTHUB_DATA/.env` (default `~/.bothub`). Then set
   `BOTHUB_LLM_BASE_URL=http://127.0.0.1:4000/v1`. Ollama and the ChatGPT login are covered in
   `infra/local/README.md`.

3. Build the sandbox image. Every agent run happens in a throwaway container from it.

   ```sh
   docker compose --profile sandbox up -d
   docker build -t bothub-sandbox:local sandbox
   ```

4. Create the GitHub App once with `node core/bin/setup-app.ts` (see `infra/github/README.md`) and
   set `BOTHUB_APP_ENV` to the `app.env` it prints. Then `infra/local/e2e.sh` prepares a data
   directory with the agents' keys and prints the commands that run a hub against its repo.

   ```sh
   ./e2e.sh /tmp/bothub-e2e ../../examples/sandbox
   ```

5. Open the studio dashboard. From `studio/`, run `npm install`, then `npm run dev -- --data /tmp/bothub-e2e`.
   The app is at http://localhost:5182. It starts its own API on port 5181, so if `serve` already
   holds that port, start `serve` with `--port` set to another one and stop one of the two.
   `npm run seed` writes sample runs if you want something to look at first.

## Docs

The docs are plain Markdown in `docs/`, starting at `docs/index.md`. `npm run verify` runs every check the project has.

## Examples

- `examples/bothub` is the hub bothub runs on its own repository.
- `examples/acme-app` is the hub for the acme-app repository: triage, implement, review and
  plans step by step.
- `examples/clarinet` is a hub for a Rust repository.
- `examples/sandbox` is a small hub over a JavaScript package, and `examples/sk` is a hub for the Acme App twin.

Every hub loads with `node core/bin/run.ts check --hub <dir>`.

`bench/` has the tools for comparing hub settings over mined cases; see `bench/README.md`.
