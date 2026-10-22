# What agentgraph is

agentgraph runs coding agents on repositories. People start and steer workflows with `/agent` comments or labels. Agents work on branches, scripts and judges check results, and humans merge.

## How data flows

The host runner polls GitHub, opens sandbox sessions and records runs. Sessions call models through a proxy and return [proposals](proposals.md). After checks, the runner applies writes to GitHub. Only the runner holds a GitHub token. The studio reads the hub and recorded runs. See [Architecture](architecture.md#where-everything-lives) for the diagram.

## Config as code

A hub holds machine-readable frontmatter and prose for agents:

```
hub/
  hub.yaml
  agents/implementor.md    role and permissions
  skills/implement.md     instructions
  checks/tests.md         acceptance checks
  workflows/issue.md      triggers and steps
```

`check` rejects unknown keys, missing agents or checks, unused skills and folders neither loaded by the engine nor read through `$AGENTGRAPH_HUB`. <!-- code: src/hub.ts#loadHub -->

## Ways in

Use the [CLI](local.md#the-cli) to validate hubs, drive issues, poll or inspect waits. Use the studio to view workflow graphs and runs.

## Guide

1. [Vocabulary](vocabulary.md)
2. [The loop](loop.md)
3. [Proposals](proposals.md)
4. [Running locally](local.md)

## Reference

- [Hub files](reference.md): fields and defaults.
- [Hub contract](contract.md): compatibility and tuning boundaries.
- [Sub-issues and stacks](stacks.md): splitting and dependencies.
- [Runs](runs.md): records, traces and debugging.
- [Sandbox and models](sandbox.md): containers, networks and harnesses.
- [Compound engineering](compound.md): retros and trace-reading agents.

## Examples

[Triage](triage.md) sizes and splits issues with hub configuration.

## Meta

- [Architecture](architecture.md): services and state machine.
- [Patterns](patterns.md): code conventions.
- [Bench](bench.md): replaying and scoring merged pull requests.
