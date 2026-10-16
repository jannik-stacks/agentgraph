# What bothub is

bothub runs coding agents on your repositories. A comment like `/bothub` on an issue starts a
workflow. Agents work on their own branch. Scripts and other agents check the result, and a human merges.

## Config as code

A hub is a folder of Markdown files with YAML frontmatter. The frontmatter is the machine part,
the body is prose for the model or for you.

```
hub/
  hub.yaml
  agents/implementor.md    who acts
  skills/implement.md      what to do
  checks/tests.md          what decides "done"
  workflows/issue.md       events to steps
```

`check` loads the hub and prints every problem with its file before anything runs: an unknown key,
a step that names a missing agent or a check that does not exist.

## Ways in

- The CLI, `node core/bin/run.ts`, checks a hub, looks at one issue or all open ones, and shows
  what waits on a human.
- The studio draws each workflow as its steps and lists runs. It reads the same files.

## Where to go next

- [Vocabulary](vocabulary.md)
- [The loop](loop.md)
- [Proposals](proposals.md)
- [Runs](runs.md)
- [Sandbox](sandbox.md)
- [Running it locally](local.md)
- [Patterns](patterns.md)
