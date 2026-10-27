# Proposals

Agents have no GitHub token. They ask the engine for writes with proposals: a reply ends with a fenced `agentgraph` block, read as a JSON array, one object, or one object per line. <!-- code: src/engine.ts#parseProposals -->

```agentgraph
[{"kind": "push", "branch": "agentgraph/42", "message": "Fix fee rounding"},
 {"kind": "pull_request", "branch": "agentgraph/42", "base": "main", "title": "Fix fee rounding", "body": "Closes #42"}]
```

## Kinds

| Kind | Fields | Effect |
| --- | --- | --- |
| `comment` | `body`, optional `under` | [Reply](#comments) where a person spoke |
| `label` | `add`, `remove` | Change labels, except trigger labels |
| `push` | `branch`, `message` | [Commit and push](#pushes) the checkout |
| `pull_request` | `branch`, `base`, `title`, `body` | Open a pull request, or update the open one for that branch |
| `merge` | `number`, `head` | Merge the run's pull request if its head still matches |
| `issue` | `relation`, `title`, `body`; parts add `size`, optional `stacks_on`, `depends_on` | [File an issue](#filing-issues) |
| `ask` | `question` | Post a question and wait |
| `back` | `why` | [Return to an earlier step](workflows.md#tries-and-going-back) |
| `run` | `workflow`, `issue`, optional `step` | [Dispatch](workflows.md#dispatch) a workflow and wait |
| `tell` | `issue`, `text` | [Forward text](workflows.md#routing) to a live run |

An agent's `returns` lists the kinds it may use, plus `ask`, and `back` on a step with `back`. The engine owns two more kinds: `react` and `rebase`. <!-- code: src/proposal.ts#React src/proposal.ts#Rebase src/proposal.ts#Said -->

## Applying

1. `ask` waits at once; checks and other proposals are skipped.
2. Checks run. A blocking failure fails the try.
3. `back` returns to its step, and nothing else applies.
4. Otherwise `tell`, then pushes, then the other writes in order, then `issue` filings, which a failed push skips. `run` dispatches last, only when nothing failed.

A missing block, invalid JSON, wrong fields or a kind the agent may not use fails the try, with the expected shape as feedback. <!-- code: src/engine.ts#attempt -->

A refused write fails the try. Any other GitHub error parks the run with a question.

## Comments

An agent posts only the kinds its `returns` lists, so a reviewer that returns `[back]` keeps its findings in the run: a pass leaves its reply in the trace, and `back` hands it to the next step as feedback.

A comment goes where a person started or woke the run, else to the branch's open pull request, else the issue. `under` names a review comment to reply under. When people spoke in several places, a comment without `under` posts once, at top level if one of them was. <!-- code: src/engine.ts#land -->

## Pushes

`push` and `pull_request` must name the run's own `agentgraph/` branch. A push is refused if the branch moved since the checkout last saw it, and never forces except to finish a [rebase](workflows.md#when-the-base-or-the-graph-moves).

While the branch has no open pull request, an agent that may return `pull_request` must return one, or an `ask`, a `back`, an `issue` part, or comments answering a finished run. <!-- code: src/engine.ts#attempt -->

A `pull_request` on a branch whose pull request is open rewrites its title and body. A step of its own after review, with an agent that returns only `pull_request`, keeps the description current each time the change goes round again. <!-- code: src/forge.ts#fileForge src/github.ts#githubForge -->

A push takes at most 200 regular files of 1 MiB each. Changes under `.github/` are left out and listed in the pull request for a maintainer. GitHub's Git API writes and signs the commits. <!-- code: src/forge.ts#unpushable -->

## Filing issues

Every `issue` body ends with a `## Done when` section of one to three observable checks.

| `relation` | Files | Label |
| --- | --- | --- |
| `part` | A sub-issue in landing order, with a `size`: `XS`, `S`, `M`, `L` or `XL` | `size/<size>` |
| `follow-up` | Work outside the issue, ending with `Found while working on #n`; it runs only once someone adds a trigger label | `follow-up` |
| `graph` | A recurring miss and the check or prompt that would catch it | `graph` |

<!-- code: src/engine.ts#file -->

The parent gets a `Split into:` comment with a task list. Each `XL` part starts the same workflow again. A follow-up or graph issue whose title matches an open one becomes a comment there. Filing uses a token limited to `issues: write`. <!-- code: src/engine.ts#filed src/github.ts#scopes -->

One refused filing fails the try and files nothing. The engine refuses a body without `## Done when`, any filing while an outsider's issue text is withheld, a part whose title matches an open issue, a reference to anything but an earlier part, and parts of an issue already three levels deep (`deepest`). <!-- code: src/engine.ts#deepest -->

### Stacks on and Depends on

`stacks_on` names one earlier part by position, from 1, and `depends_on` lists earlier positions. The engine writes them as `Stacks on #n` and `Depends on #n` lines; on an existing issue, write the line yourself.

With `stacks: true` in `settings.yaml`, `Stacks on #n` builds on #n's open pull request or workflow branch, targets it, and registers a GitHub stack where the repo supports it. <!-- code: src/engine.ts#findStackBase src/github.ts#githubForge -->

A workflow with a `branch` holds a run, `running` but not driven, until every `Depends on #n` issue is closed and every `Stacks on #n` issue has a pull request. When a stacked parent's head moves, the child rebases onto it; a conflict asks for a manual rebase. <!-- code: src/engine.ts#pending src/engine.ts#follow -->

### The triage example

`examples/sandbox` sizes and splits issues with graph files alone. `workflows/triage.md` starts on the `triage` label or a dispatch. Its triager reads code and returns `label`, `issue` or one `ask` of at most six questions; it never implements, merges or closes. The blocking `checks/sized.md` wants one size label, or a split into smaller parts.
