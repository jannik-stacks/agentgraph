# What bothub is

A personal agent hub driven by GitHub, configured as code.

bothub runs coding agents on your repositories. A comment like `/bothub` on an issue starts a
workflow. Agents do the work on their own branch, scripts and other agents check it, and every
change reaches GitHub as a proposal that bothub validates first. A human merges.

## Config as code

A hub is a folder of Markdown files with YAML frontmatter. The frontmatter is the machine part,
the body is prose for the model or for you.

```
hub/
  hub.yaml
  bots/implementor.md      who acts
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

- [Vocabulary](vocabulary.md) for the words the rest of the docs use.
- [The loop](loop.md) for how a step keeps going until its checks pass.
- [Proposals](proposals.md) for what an agent may change.
- [Runs](runs.md) and [Sandbox](sandbox.md) for what a run leaves behind and where it runs.
- [Running it locally](local.md) to try it, and [Patterns](patterns.md) for the code's conventions.
