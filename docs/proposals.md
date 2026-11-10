# Proposals

Agents have no GitHub token. They ask the engine for writes with proposals: a reply ends with a fenced `agentgraph` block, read as a JSON array, one object, or one object per line. <!-- code: src/run/attempt.ts#parseProposals -->

```agentgraph
[{"kind": "push", "branch": "agentgraph/42", "message": "Fix fee rounding"},
 {"kind": "pull_request", "branch": "agentgraph/42", "base": "main", "title": "Fix fee rounding", "body": "Closes #42"}]
```

## Kinds

| Kind | Fields | Effect |
| -------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `comment` | `body`, optional `under` | [Reply](#comments) where a person spoke |
| `label` | `add`, `remove` | Change labels, except trigger labels |
| `push` | `branch`, `message` | [Commit and push](#pushes) the checkout |
| `pull_request` | `branch`, `base`, `title`, `body` | Open a pull request, or update the open one for that branch |
| `merge` | `number`, `head` | Merge the run's pull request if its head still matches |
| `issue` | `relation`, `title`, `body`; parts add `size`, optional `stacks_on`, `depends_on` | [File an issue](#filing-issues) |
| `ask` | `question` | Post a question and wait |
| `ask` | `runner` | Report a sandbox, checkout, network or tool problem; the engine handles it as an [engine error](workflows.md#order-and-limits) and asks no one |
| `back` | `why` | [Return to an earlier step](workflows.md#tries-and-going-back) |
| `run` | `workflow`, `issue`, optional `step` | [Dispatch](workflows.md#dispatch) a workflow and wait |
| `tell` | `issue`, `text` | [Forward text](workflows.md#routing) to a live run |

An agent's `returns` lists the kinds it may use, plus `ask`, and `back` on a step with `back`. A `run` step's own `returns` limits what its script prints, `ask` and `back` included, by default to `run`; see [Gates](workflows.md#gates). The engine owns two more kinds: `react` and `rebase`. <!-- code: src/proposal.ts#Kind src/proposal.ts#Proposal src/proposal.ts#React src/proposal.ts#Rebase src/proposal.ts#Said -->

## Applying

The engine rejects malformed or ungranted proposals before applying anything. <!-- code: src/run/attempt.ts#runAttempt -->

An `ask` skips checks and other proposals. Otherwise checks run first; a blocking failure retries the step. A `back` then returns to its target without applying other writes. Remaining proposals apply in order: tells, pushes, other writes, issue filings, then dispatch. Refused writes fail the try; tracker errors park it after retry. <!-- code: src/run/attempt.ts#runAttempt src/run/settle.ts#writeProposals -->

## Comments

A step speaks on the tracker only through its granted proposal kinds. A reply without a comment proposal stays in the run; a `back` carries feedback to its target step. <!-- code: src/workflow.ts#transition -->

Comments reply where a person woke the run, otherwise on its open pull request, otherwise on the issue. `under` selects a review thread by its first comment's ID. <!-- code: src/run/settle.ts#writeProposals -->

## Pushes

`push` and `pull_request` must name the run's own branch under the enforced `agentgraph/` prefix. A moved branch refuses a push; only engine rebases force updates. <!-- code: src/run/attempt.ts#pickTryOutcome src/tracker.ts#folderTracker src/github.ts#githubTracker -->

A step allowed to open a pull request must propose one while none is open, unless it asks, goes back, splits the issue or only answers comments on a finished run. <!-- code: src/run/attempt.ts#runAttempt -->

A `pull_request` updates the open pull request for its branch or creates one. The engine appends a [run link](runs.md#run-links) and maintains the [status header](workflows.md#status-on-the-issue). <!-- code: src/tracker.ts#folderTracker src/github.ts#githubTracker -->

A push accepts at most 200 regular files of 1 MiB each. Paths under `.github/` are held for a maintainer. The trace records them in `held`; the first push holding a path is incomplete even if other files landed. Later pushes can succeed while still listing it. GitHub commits use the Git API. <!-- code: src/tracker.ts#pushLimits src/tracker.ts#unpushable src/event.ts#Applied src/tracker.ts#makePushResult src/run/settle.ts#writeProposals -->

## Filing issues

Issue proposals use these fixed relations and labels:

| `relation` | Effect |
| --- | --- |
| `part` | Sub-issue with required `size`: `XS`, `S`, `M`, `L` or `XL`, labelled `size/<size>` |
| `follow-up` | Separate issue labelled `follow-up` |
| `graph` | Separate issue labelled `graph` |

The engine and triage-brief check require a `## Done when` heading in each proposed body. It does not require the heading to end the body or count its checks. These are current filing restrictions, independent of the graph's prompts. <!-- code: src/run/start.ts#createIssues -->

Parts produce a `Split into:` task list on the parent. Eligible `XL` parts start the same workflow again. Other relations append `Found while working on #n`; a matching open title receives a comment instead. Follow-up and graph filings start no runs automatically. Filing uses an issues-write token. <!-- code: src/run/start.ts#createIssues src/run/start.ts#readFiledIssues src/github.ts#scopes -->

Validation refuses the whole batch if an issue's text is withheld, a part duplicates an open title, a part has an invalid position reference, or the parent is already three levels deep (`deepest`). <!-- code: src/run/start.ts#deepest -->

### Stacks on and Depends on

`stacks_on` selects one earlier part by position, counted from 1; `depends_on` lists earlier positions. Filing writes `Stacks on #n` and `Depends on #n` lines into the issues. Existing issues can use those lines directly. The tracker reads them once into the issue's `stacksOn` and `dependsOn`; GitHub adds the issues it records as blocking one, and the folder tracker reads both fields from frontmatter too. <!-- code: src/run/start.ts#createIssues src/tracker.ts#parseIssueLinks src/github.ts#githubTracker -->

With `stacks: true`, stacking builds on the parent's open pull request, never a bare workflow branch. The child targets that pull request's branch; GitHub registers a stack where supported. <!-- code: src/run/drive.ts#findStackBase src/github.ts#githubTracker -->

For workflows with a `branch`, `Depends on #n` holds the run until that issue closes. `Stacks on #n` holds while the parent is open without a pull request, even when stacking is off. A held run stays `running` and records why it is held. If the parent closes without a pull request, the hold clears and the run silently uses its configured base branch. <!-- code: src/run/trigger.ts#findHold src/run/drive.ts#runWorkflow -->

When a stacked parent's head moves, the child rebases onto it. A conflict asks for a manual rebase. <!-- code: src/run/follow.ts#runFollow -->
