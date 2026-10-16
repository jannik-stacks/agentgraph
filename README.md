# bothub

bothub is an agent hub. Scripts slice the work, and many narrow
agents each judge one piece. A hub is the config: `hub.yaml` and agents, skills, checks and workflows, all
Markdown files with YAML frontmatter, plus the scripts its checks run. See `docs/index.md` for how a change reaches the repository.

Needs Node 22.18 or later, and Docker for the sandbox.

## Commands

Run them from this directory as `node bin/run.ts <command>`. `docs/local.md` has the details.

- `check --hub <dir>` loads a hub and prints every problem with its file, or `ok`.
- `--hub <dir> --issue <n> --data <dir>` looks at one issue once and drives its run until it waits or ends.
  `--all` does the same for every open issue.
- `loop --hub <dir> --data <dir>` looks at every open issue each `BOTHUB_EVERY` minutes.
- `status --hub <dir> --data <dir>` lists what waits on a human.

`node bin/traces.mjs <data dir>` fails when a session that started cost nothing, so missing usage or prices show.

## Local quickstart

1. Validate a hub, which needs no model or container.

   ```sh
   node bin/run.ts check --hub examples/acme-app
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

4. Create the GitHub App once with `node bin/setup-app.ts` (see `infra/github/README.md`) and
   set `BOTHUB_APP_ENV` to the `app.env` it prints. Then `infra/local/e2e.sh` prepares a data
   directory with the agents' keys and prints the commands that run a hub against its repo.

   ```sh
   ./e2e.sh /tmp/bothub-e2e ../../examples/sandbox
   ```

5. Open the studio dashboard. From `studio/`, run `npm install`, then `npm run dev -- --data /tmp/bothub-e2e`.
   The app is at http://localhost:5182.

## Docs

The docs are plain Markdown in `docs/`, starting at `docs/index.md`. `npm run verify` runs every check the project has.

## Git hooks

`npm run hooks` points git at `bin/hooks`. Then a commit that touches `bothub/` runs `npm run precommit`,
the studio build when it touches `studio/` or `src/`, and the pr-text rules on its message. It sets
`core.hooksPath` for the whole repository and every worktree; `git config --unset core.hooksPath` undoes it.

## Examples

- `examples/bothub` is the hub bothub runs on its own repository.
- `examples/acme-app` is the hub for the acme-app repository: triage, implement, review and
  plans step by step.
- `examples/clarinet` is a hub for a Rust repository.
- `examples/sandbox` is a small hub over a JavaScript package, and `examples/sk` is a hub for the Acme App twin.

Every hub loads with `node bin/run.ts check --hub <dir>`.
