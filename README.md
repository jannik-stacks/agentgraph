# agentgraph

agentgraph runs coding agents on repositories. Scripts slice work, narrow agents judge it, and the engine applies checked proposals. A hub configures agents, skills, checks and workflows as Markdown with YAML frontmatter, plus `hub.yaml` and scripts.

Requires Node 22.18 or later and Docker. Read [the overview](docs/index.md) or [local setup](docs/local.md) first.

## Commands

From this directory:

```sh
node bin/run.ts check --hub examples/sandbox
node bin/run.ts loop --hub examples/sandbox --data <dir>
node bin/run.ts status --hub examples/sandbox --data <dir>
```

[CLI reference](docs/local.md#the-cli) covers single issues, sweeps, routing and configuration. [Runs](docs/runs.md) covers traces and debugging.

## Local quickstart

[Running it locally](docs/local.md) covers the proxy, sandbox image, keys and GitHub App. To try a repo without GitHub, create a [local instance](docs/local.md#instances), then run its loop and open the studio against it.

## Docs

Start at [docs/index.md](docs/index.md). `npm run verify:docs` checks docs references and commands; `npm run verify` runs the full project checks.

## Git hooks

`npm run hooks` enables `bin/hooks` for the whole repository and all worktrees. Commits touching `agentgraph/` run precommit checks and message rules; changes to `studio/` or `src/` also build the studio. Undo with `git config --unset core.hooksPath`.

## Examples

| Hub | Repo or purpose |
| --- | --- |
| `examples/agentgraph` | agentgraph itself |
| `examples/acme-app` | acme-app triage, implementation, review and plans |
| `examples/clarinet` | Rust |
| `examples/sandbox` | Small JavaScript package |
| `examples/sk` | Acme App twin |
