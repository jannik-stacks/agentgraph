# agentgraph-setup

An [Agent Skills](https://agentskills.io/specification) skill that sets up agentgraph for a repo. It writes a
minimal `.agentgraph/` that passes `agi check`, then offers optional steps that each run only on a yes: it mines the repo's CI, scripts, configs, commit and
review history, and with the user's consent their Claude Code or Codex transcripts, and proposes checks backed
by that evidence. It never commits or pushes on its own. It runs agentgraph as `agi`, or `npx @jannik-stacks/agi`
without installing; the unscoped `agentgraph` npm package is unrelated.

`SKILL.md` is the skill. `references/` holds the format, the optional steps, the mining playbook, check patterns and the transcript
rules, loaded when a step needs them. `scripts/` slice the repo into JSON lines with Node and git alone, and
`gh` when it is logged in; `assets/` holds check scripts to copy into a graph.

## Install

With the [skills CLI](https://github.com/vercel-labs/skills), which installs into each agent's folder:

```sh
npx skills add jannik-stacks/agentgraph --skill agentgraph-setup            # this project
npx skills add jannik-stacks/agentgraph --skill agentgraph-setup -g -a claude-code codex cursor
```

`npx skills add` clones the repo, so it works once the repo is public. Until then, or offline:

Copy the folder by hand:

| Agent       | Project                                                                  | User                                 |
| ----------- | ------------------------------------------------------------------------ | ------------------------------------ |
| Claude Code | `.claude/skills/agentgraph-setup/`                                       | `~/.claude/skills/agentgraph-setup/` |
| Codex       | `.agents/skills/agentgraph-setup/`                                       | `~/.agents/skills/agentgraph-setup/` |
| Cursor      | `.agents/skills/` or `.cursor/skills/` (it also reads `.claude/skills/`) | `~/.cursor/skills/agentgraph-setup/` |

Then ask the agent to set up agentgraph for the repo.

## Try the scripts alone

From a repo root, read only:

```sh
node <skill>/scripts/slice-repo.mjs | head
node <skill>/scripts/slice-history.mjs --prs 30 --comments 100 | head
node <skill>/scripts/scan-private.mjs .agentgraph
```
