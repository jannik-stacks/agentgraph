# Proposals

End replies with a fenced `agentgraph` block containing a JSON array, one object, or one object per line. See [Sandbox](sandbox.md#the-sandbox) for credential isolation. <!-- code: src/run/attempt.ts#parseProposals -->

```agentgraph
[{"kind": "push", "branch": "agentgraph/42", "message": "Fix fee rounding"},
 {"kind": "pull_request", "branch": "agentgraph/42", "base": "main", "title": "Fix fee rounding", "body": "Closes #42"}]
```

## Kinds

| `kind` | Fields | Action |
| --- | --- | --- |
| `comment` | `body`, optional `under` | [Reply](#comments) |
| `label` | `add`, `remove` | Excludes trigger and `agent:` labels |
| `push` | `branch`, `message` | [Commit and push](#pushes) |
| `pull_request` | `branch`, `base`, `title`, `body` | Create or update by branch |
| `merge` | `number`, `head` | Merge run's pull request with matching head |
| `issue` | `relation`, `title`, `body`; parts require `size`, optional `stacks_on`, `depends_on` | [File](#filing-issues) |
| `ask` | `question` | Ask and wait |
| `ask` | `runner` | Report sandbox, checkout, network or tool [error](workflows.md#order-and-limits); asks nobody |
| `back` | `why` | [Return](workflows.md#tries-and-going-back) |
| `run` | `workflow`, `issue`, optional `step` | [Dispatch and wait](workflows.md#dispatch) |
| `tell` | `issue`, `text` | [Forward](workflows.md#routing) |

Agents may use their `returns`, plus `ask` and configured `back`. Script `returns` defaults to `run` and must grant `ask` and `back` explicitly. Only the engine uses `react` and `rebase`. <!-- code: src/proposal.ts#Kind src/proposal.ts#Proposal src/proposal.ts#React src/proposal.ts#Rebase src/proposal.ts#Said -->

## Applying

The engine validates proposals before applying anything. `ask` skips checks and other proposals. Otherwise, checks run first; blocking failures retry. Then `back` returns without writes. Remaining proposals apply in order: tells -> pushes -> other writes -> filings -> dispatch. Refusals fail tries; tracker errors retry, then park. <!-- code: src/run/attempt.ts#runAttempt src/run/settle.ts#writeProposals -->

## Comments

Tracker writes require grants. Replies without `comment` stay in the run. <!-- code: src/workflow.ts#transition -->

Comments reply where a person woke the run, otherwise on its open pull request, otherwise on the issue. `under` selects a review thread by its first comment's ID. <!-- code: src/run/settle.ts#writeProposals -->

## Pushes

`push` and `pull_request` require the run's `agentgraph/` branch. A moved branch refuses pushes; only engine rebases force updates. <!-- code: src/run/attempt.ts#pickTryOutcome src/tracker.ts#folderTracker src/github.ts#githubTracker -->

A step granted `pull_request` must propose one if none is open, unless it asks, goes back, splits the issue or only answers comments on a finished run. <!-- code: src/run/attempt.ts#runAttempt -->

Pushes carry regular files without a size cap. Use a [size check](../examples/agentgraph/checks/size.md). GitHub refusals name paths. `.github/` paths await maintainers and appear in `held`. The first push holding a path is incomplete even if other files landed. Later pushes can succeed. <!-- code: src/tracker.ts#unpushable src/github.ts#githubTracker src/event.ts#Applied src/tracker.ts#makePushResult src/run/settle.ts#writeProposals examples/agentgraph/scripts/size.mjs -->

## Filing issues

| `relation` | Result |
| --- | --- |
| `part` | Sub-issue; required `size`: `XS`, `S`, `M`, `L`, `XL`; label `size/<size>` |
| `follow-up` | Separate issue, label `follow-up` |
| `graph` | Separate issue, label `graph` |

Each `body` requires `## Done when`. <!-- code: src/run/start.ts#createIssues -->

Parts add a `Split into:` task list on the parent; eligible `XL` parts restart the workflow. Other relations append `Found while working on #n`; matching open titles receive comments. Neither `follow-up` nor `graph` starts runs. Filing requires an issues-write token. <!-- code: src/run/start.ts#createIssues src/run/start.ts#readFiledIssues src/github.ts#scopes -->

The engine rejects the batch for withheld text, parts duplicating open titles, invalid position references or parents already three levels deep. <!-- code: src/run/start.ts#deepest -->

### Stacks on and Depends on

`stacks_on` selects one earlier part; `depends_on` lists earlier parts, numbered from 1. Existing issues can use `Stacks on #n` and `Depends on #n` lines directly. Trackers read these once into `stacksOn` and `dependsOn`. GitHub includes recorded blockers; folder trackers also read frontmatter. <!-- code: src/run/start.ts#createIssues src/tracker.ts#parseIssueLinks src/github.ts#githubTracker -->

`stacks: true` builds on a parent's open pull request, targets its branch and registers GitHub stacks where supported. <!-- code: src/run/drive.ts#findStackBase src/github.ts#githubTracker -->

For workflows with `branch`, dependencies hold runs until those issues close. With `stacks: true`, unstarted children await open parents' pull requests; otherwise stacking imposes no hold. Held runs stay `running` with reasons. After a parent merges, its child starts on the configured base. Unmerged closure keeps children held. <!-- code: src/run/trigger.ts#findHold src/run/trigger.ts#isWorkLanded src/run/drive.ts#runWorkflow -->

When a stacked parent's head changes, children rebase onto it. Conflicts require manual rebases. <!-- code: src/run/follow.ts#runFollow -->
