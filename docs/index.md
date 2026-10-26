# What agentgraph is

agentgraph runs coding agents on a repository's issues. People start and steer workflows with `/agent` comments or labels. Agents work on branches in sandboxes, scripts and judge agents check the result, and people merge.

The runner on the host polls GitHub, starts sandbox sessions and records each run. Sessions reach models through a proxy and return [proposals](proposals.md). Only the runner holds a GitHub token, and it applies proposals after the checks pass. The studio shows the graph and the recorded runs. [Architecture](architecture.md) has the diagram.

## The agentgraph folder

A repo keeps its graph in `.agentgraph/`, a folder of Markdown files with frontmatter. The engine reads the frontmatter, and agents read the prose.

```
.agentgraph/
  settings.yaml
  agents/implementor.md    role, harness, model, allowed proposals
  skills/implement.md      instructions
  checks/tests.md          a script or a judge
  workflows/issue.md       triggers and steps
```

`npx agentgraph check --dir <dir>` validates one; [Graph files](reference.md) lists every field. <!-- code: src/folder.ts#loadGraph -->

## Guide

1. [Vocabulary](vocabulary.md)
2. [The loop](loop.md)
3. [Proposals](proposals.md)
4. [Running locally](local.md)
5. [Without GitHub](forge.md)
6. [Hosting](hosting.md)
7. [On Cloudflare](cloudflare.md)

## Reference

- [Graph files](reference.md): fields and defaults.
- [Graph contract](contract.md): what stays stable and what tunes may change.
- [Sub-issues and stacks](stacks.md): splitting work and dependencies.
- [Runs](runs.md): records, traces and debugging.
- [Sandbox and models](sandbox.md): containers, networks, caches and harnesses.
- [Compound engineering](compound.md): retros and agents that read traces.

## Examples

- [Triage](triage.md): sizing and splitting issues with graph config only.

## Meta

- [Architecture](architecture.md): services and the state machine.
- [Patterns](patterns.md): code conventions and checks before committing.
- [Bench](bench.md): replaying and scoring merged pull requests.
