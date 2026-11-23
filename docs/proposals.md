# Proposals

A proposal asks the engine to take an action. An agent or script returns proposals in a fenced `agentgraph` block. The engine reads the last such block and accepts a JSON array, one object, or one object per line. See [sandbox credentials](sandbox.md#the-sandbox). <!-- code: src/run/attempt.ts#parseProposals src/proposal.ts#Said -->

```agentgraph
[{"kind": "push", "branch": "agentgraph/42", "message": "Fix fee rounding"},
 {"kind": "pull_request", "branch": "agentgraph/42", "base": "main", "title": "Fix fee rounding", "body": "Closes #42"}]
```

## Kinds

| `kind` | Fields | Action |
| --- | --- | --- |
| `comment` | `body`, optional `under` | [Reply to a discussion](#comments) |
| `label` | Optional `add` and optional `remove` | Change issue labels, excluding trigger and `agent:` labels |
| `push` | `branch`, `message` | [Commit and push changes](#pushes) |
| `pull_request` | `branch`, `base`, `title`, `body` | Open or update a pull request for the branch |
| `merge` | `number`, `head` | Merge the run's own pull request if its head matches |
| `issue` | `relation`, `title`, `body`. Parts also require `size` and can set `stacks_on` and `depends_on`. | [File an issue](#filing-issues) |
| `ask` | `question` | Ask a person and wait for an answer |
| `ask` | `runner` | Report a sandbox, checkout, network or tool problem as an [engine error](workflows.md#engine-errors) |
| `back` | `why` | [Return to a step](workflows.md#tries-and-going-back) |
| `run` | `workflow`, `issue`, optional `step` | [Dispatch a child run](workflows.md#dispatch) |
| `tell` | `issue`, `text` | [Forward text to a run](workflows.md#routing) |

<!-- code: src/proposal.ts#Said src/run/attempt.ts#pickTryOutcome src/run/settle.ts#writeProposals src/github.ts#githubTracker src/tracker.ts#folderTracker -->

An agent can use the kinds in its `returns`, plus `ask` and, when the step has a way back, `back`. A script must grant `ask` and `back` explicitly. An ungranted kind fails the try before the engine applies any proposals. Only the engine makes `react` and `rebase` proposals. <!-- code: src/run/attempt.ts#findUngranted src/run/attempt.ts#pickTryOutcome src/proposal.ts#Kind src/proposal.ts#Proposal -->

## Applying

An `ask` skips the checks and other proposals. Otherwise the engine checks the reply before applying writes. If a blocking check fails, the step gets the findings. A valid `back` then returns to its target without applying writes. For other replies, the engine delivers tells, applies pushes, makes other tracker writes, files issues and finally dispatches a child run. A refused proposal fails the try. A tracker error follows the [engine retry rules](workflows.md#engine-errors). <!-- code: src/run/attempt.ts#runAttempt src/run/settle.ts#writeProposals src/run/start.ts#createIssues -->

## Comments

A reply stays in the run unless the step proposes a `comment`. The engine posts the comment where a person woke the run, otherwise on its open pull request, or on the issue if it has no open pull request. Set `under` to the ID of the first comment in a review thread to reply there. <!-- code: src/run/attempt.ts#runAttempt src/run/settle.ts#writeProposals src/proposal.ts#Said -->

## Pushes

A `push` or `pull_request` must name the run's own `agentgraph/` branch. If the branch moved unexpectedly, the tracker refuses the push. Only engine-initiated rebases can force an update. A step granted `pull_request` must propose one when it needs a pull request, unless it asks, goes back, splits the issue or only answers comments on finished work. <!-- code: src/run/attempt.ts#pickTryOutcome src/run/attempt.ts#runAttempt src/tracker.ts#folderTracker src/github.ts#githubTracker -->

The tracker pushes regular files without a size cap. To impose one, add a [size check](../examples/agentgraph/checks/size.md). A push result's `held` list names paths the tracker could not push, including files under `.github/` that need a maintainer. When a path first appears there, the push is incomplete even if other files landed. Later pushes can succeed with the same paths listed. <!-- code: src/tracker.ts#unpushable src/tracker.ts#makePushResult src/github.ts#githubTracker src/event.ts#Applied examples/agentgraph/scripts/size.mjs -->

## Filing issues

| `relation` | What the engine files |
| --- | --- |
| `part` | A sub-issue with a required `size` of `XS`, `S`, `M`, `L` or `XL` and a matching `size/<size>` label |
| `follow-up` | A separate issue with the `follow-up` label |
| `graph` | A separate issue with the `graph` label |

<!-- code: src/proposal.ts#Said src/run/start.ts#createIssues -->

Every issue body needs a `## Done when` heading. The engine rejects the batch if the parent has withheld text, a proposed part duplicates an open title, a position refers outside the earlier proposals, or a parent being split is already three levels deep. GitHub filing needs an issues-write token. <!-- code: src/run/start.ts#createIssues src/run/start.ts#deepest src/github.ts#scopes -->

The engine posts a `Split into:` task list on the parent issue. See [when a part starts work](workflows.md#trust-and-scope). A follow-up or graph issue includes `Found while working on #n`. If its title already matches an open issue, the engine adds a comment there. Filing a follow-up or graph issue does not start a run. <!-- code: src/run/start.ts#createIssues src/run/start.ts#readFiledIssues -->

### Stacks on and Depends on

Use `stacks_on` for the earlier issue that supplies this part's base branch. Use `depends_on` for the earlier issues it needs to finish first. Both refer to positions in the filing batch, counting from 1. The engine replaces those positions with issue numbers. Existing issues can declare the same links with `Stacks on #n` and `Depends on #n` lines. Trackers expose the links as `stacksOn` and `dependsOn`. GitHub also reads recorded blockers, and the folder tracker accepts links in frontmatter. See [stacked and dependent issues](workflows.md#stacked-and-dependent-issues) for run behaviour. <!-- code: src/run/start.ts#createIssues src/tracker.ts#parseIssueLinks src/tracker.ts#folderTracker src/github.ts#githubTracker -->
