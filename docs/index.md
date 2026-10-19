# What bothub is

bothub runs coding agents on a team's repositories. Mentioning the bot (`@stx-bothub`) on a GitHub issue starts a workflow; `/bothub` works as a fallback.

Agents work on their own branch. Scripts and other agents check the result. A human merges.

## How data flows

```
 ┌──────────────────────────────────────────┐
 │ GitHub issue: a bot mention or a label   │
 └────────────────────┬─────────────────────┘
                      ▼
 ┌──────────────────────────────────────────┐      ┌──────────────────────┐
 │ runner (the engine)                      │─────►│ data dir             │
 │ looks every few minutes                  │      │ run.json, trace      │
 │                                          │      │ the studio reads it  │
 └────────────────────┬─────────────────────┘      └──────────────────────┘
                      ▼
 ┌──────────────────────────────────────────┐      ┌──────────────────────┐
 │ sandbox: one session                     │◄────►│ model proxy          │
 │ on the run's branch                      │      │ then model providers │
 └────────────────────┬─────────────────────┘      └──────────────────────┘
                      ▼
 ┌──────────────────────────────────────────┐
 │ the reply ends with proposals            │
 │ push, pull_request, comment, ...         │
 └────────────────────┬─────────────────────┘
                      ▼
 ┌──────────────────────────────────────────┐
 │ the engine runs the checks,              │
 │ then applies the proposals               │
 └────────────────────┬─────────────────────┘
                      ▼
 ┌──────────────────────────────────────────┐
 │ GitHub: a pushed branch, a pull request, │
 │ comments, labels                         │
 └──────────────────────────────────────────┘
```

The agent never holds a GitHub token. It can only propose, and the engine decides what lands.

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

`check` loads the hub and prints every problem with its file before anything runs. It reports unknown keys, steps naming agents that do not exist, checks that do not exist, a skill no step names and no skill uses, and a folder that neither the engine loads nor a hub script reads through `$BOTHUB_HUB` (`code: src/hub.ts#loadHub`).

## Ways in

- CLI: `node bin/run.ts` checks a hub, looks at one issue or all open ones, runs the polling loop, and shows what waits on a human.
- The studio (web UI) draws each workflow as its steps and lists runs. It reads the same files.

## Guide

New here? Read these in order.

1. [Vocabulary](vocabulary.md): the terms the other pages use.
2. [The loop](loop.md): how a workflow turns into steps, checks, tries and waiting.
3. [Proposals](proposals.md): what an agent may ask for and how it lands on GitHub.
4. [Running it locally](local.md): trying it on the sandbox hub.

## Reference

- [Hub files](reference.md): every field of every hub file.
- [Sub-issues and stacks](stacks.md): splitting an issue and building on another's pull request.
- [Runs](runs.md): what a run records in the data dir.
- [Sandbox and models](sandbox.md): the container, its network, harnesses and models.

## Examples

- [Triage](triage.md): an example workflow that sizes and splits issues.

## Meta

- [Architecture](architecture.md): where each part runs and what is code versus judgement.
- [Patterns](patterns.md): the conventions the engine's code follows.
- [Bench](bench.md): replaying merged pull requests and judging the results blind.
