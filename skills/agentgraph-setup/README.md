# agentgraph-setup

An [Agent Skills](https://agentskills.io/specification) skill that sets up agentgraph for a repo. It writes a
minimal `.agentgraph/` that passes `agi check`, then proposes checks backed by evidence from the repo's CI,
scripts, configs, history and, with consent, the user's Claude Code or Codex transcripts. It never commits or
pushes on its own.

`SKILL.md` is the skill, `references/` hold the details each step loads, `scripts/` slice the repo into JSON
lines with Node, git and optionally `gh`, and `assets/` hold check scripts to copy into a graph.

## Install

With the [skills CLI](https://github.com/vercel-labs/skills), which installs into each agent's folder:

```sh
npx skills add jannik-stacks/agentgraph --skill agentgraph-setup            # this project
npx skills add jannik-stacks/agentgraph --skill agentgraph-setup -g -a claude-code codex cursor
```

Offline, copy the folder by hand:

| Agent       | Project                                                                  | User                                 |
| ----------- | ------------------------------------------------------------------------ | ------------------------------------ |
| Claude Code | `.claude/skills/agentgraph-setup/`                                       | `~/.claude/skills/agentgraph-setup/` |
| Codex       | `.agents/skills/agentgraph-setup/`                                       | `~/.agents/skills/agentgraph-setup/` |
| Cursor      | `.agents/skills/` or `.cursor/skills/` (it also reads `.claude/skills/`) | `~/.cursor/skills/agentgraph-setup/` |

Then ask the agent to set up agentgraph for the repo.

## Try the scripts alone

From a repo root; they only read:

```sh
node <skill>/scripts/slice-repo.mjs | head
node <skill>/scripts/slice-history.mjs --prs 30 --comments 100 | head
node <skill>/scripts/scan-private.mjs .agentgraph
```
