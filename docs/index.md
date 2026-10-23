# What agentgraph is

agentgraph runs coding agents on a repository's issues. People start and steer workflows with `/agent` comments or labels. Agents work on branches in sandboxes, scripts and judge agents check the result, and people merge.

The runner on the host polls GitHub, starts sandbox sessions and records each run. Sessions reach models through a proxy and return [proposals](proposals.md). Only the runner holds a GitHub token, and it applies proposals after the checks pass. The studio shows the hub and the recorded runs. [Architecture](architecture.md) has the diagram.

## The hub

A hub is a folder of Markdown files with frontmatter. The engine reads the frontmatter, and agents read the prose.

```
hub/
  hub.yaml
  agents/implementor.md    role, harness, model, allowed proposals
  skills/implement.md      instructions
  checks/tests.md          a script or a judge
  workflows/issue.md       triggers and steps
```

`npx agentgraph check --hub <dir>` validates one; [Hub files](reference.md) lists every field. <!-- code: src/hub.ts#loadHub -->

## Guide

1. [Vocabulary](vocabulary.md)
2. [The loop](loop.md)
3. [Proposals](proposals.md)
4. [Running locally](local.md)

## Reference

- [Hub files](reference.md): fields and defaults.
- [Hub contract](contract.md): what stays stable and what tunes may change.
- [Sub-issues and stacks](stacks.md): splitting work and dependencies.
- [Runs](runs.md): records, traces and debugging.
- [Sandbox and models](sandbox.md): containers, networks, caches and harnesses.
- [Compound engineering](compound.md): retros and agents that read traces.

## Examples

- [Triage](triage.md): sizing and splitting issues with hub config only.

## Meta

- [Architecture](architecture.md): services and the state machine.
- [Patterns](patterns.md): code conventions and checks before committing.
- [Bench](bench.md): replaying and scoring merged pull requests.
