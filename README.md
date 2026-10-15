# bothub

bothub is an agent hub. A script slices the work and decides what a rule can decide. Many narrow
bots each judge one small piece, so a small model cannot get much wrong. A hub is the config: bots,
skills, checks, workflows and notes, all Markdown files with YAML frontmatter. Every change reaches
the repository as a proposal that bothub validates first, and a human merges.

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
- `mcp` serves a hub's tools over MCP on stdio. It is not listed in `--help`.

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

1. Validate a hub and dry-run a webhook, which needs no model or container.

   ```sh
   node bin/bothub.mjs check --dir examples/acme-app
   node bin/bothub.mjs run --event issue_comment examples/payloads/issue-comment.json --dir examples/hub --dry-run
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

4. Serve a hub. `infra/local/e2e.sh` prepares a data directory with a copy of `examples/acme-app`
   and a local origin; `comment.sh` plays the human.

   ```sh
   ./e2e.sh /tmp/bothub-e2e
   node ../../bin/bothub.mjs serve --hub /tmp/bothub-e2e/hub --data /tmp/bothub-e2e --repo /tmp/bothub-e2e/origin.git --name acme/app
   ./comment.sh /tmp/bothub-e2e/hub 6 '/bothub add kit/tests/smoke.test.ts with one test'
   ```

5. Open the studio dashboard. From `studio/`, run `npm install`, then `npm run dev -- --data /tmp/bothub-e2e`.
   The app is at http://localhost:5182. It starts its own API on port 5181, so if `serve` already
   holds that port, start `serve` with `--port` set to another one and stop one of the two.
   `npm run seed` writes sample runs if you want something to look at first.

## Docs

The docs are in `studio/content/docs` and show up in the studio's Docs tab. Start with
`index.mdx`, then `loop.mdx` for how a job runs, `runs.mdx` for what is kept on disk, `sandbox.mdx`
and `local.mdx`. `npm run verify` runs every check the project has.

## Examples

- `examples/bothub` is the hub bothub runs on its own repository.
- `examples/acme-app` is the hub for the acme-app repository: triage, implement, review and
  plans step by step.
- `examples/clarinet` is a hub for a Rust repository, with its own sandbox setup.
- `examples/hub` is a small hub for trying `check` and `run --dry-run`.
- `examples/payloads` holds sample webhook payloads.

`bench/` has the tools for comparing hub settings over mined cases; see `bench/README.md`.
