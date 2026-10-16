# What bothub is

bothub runs coding agents on a team's repositories. A comment like `/bothub` on a GitHub issue starts a workflow.

Agents work on their own branch. Scripts and other agents check the result. A human merges.

## Config as code

A hub is a folder of Markdown files with YAML frontmatter. Frontmatter is for the machine. The body is prose for the model or for people.

```
hub/
  hub.yaml
  agents/implementor.md    who acts
  skills/implement.md      what to do
  checks/tests.md          what decides "done"
  workflows/issue.md       events to steps
```

`check` loads the hub and prints every problem with its file before anything runs. It reports unknown keys, steps naming agents that do not exist, and checks that do not exist.

## Ways in

- CLI: `node bin/run.ts` checks a hub, looks at one issue or all open ones, and shows what waits on a human.
- The studio (web UI) draws each workflow as its steps and lists runs. It reads the same files.

## Where to go next

- [Vocabulary](vocabulary.md)
- [The loop](loop.md): triggers, steps, checks, tries, back and rounds, waiting
- [Triage](triage.md): sizing, splitting, stacking and ordering issues
- [Proposals](proposals.md)
- [Runs](runs.md)
- [Sandbox](sandbox.md)
- [Running it locally](local.md)
- [Patterns](patterns.md)
- [Architecture](architecture.md)
