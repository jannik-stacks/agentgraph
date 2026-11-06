# Proposals

Agents have no GitHub token. They ask the engine for writes with proposals: a reply ends with a fenced `agentgraph` block, read as a JSON array, one object, or one object per line. <!-- code: src/run/attempt.ts#parseProposals -->

```agentgraph
[{"kind": "push", "branch": "agentgraph/42", "message": "Fix fee rounding"},
 {"kind": "pull_request", "branch": "agentgraph/42", "base": "main", "title": "Fix fee rounding", "body": "Closes #42"}]
```

## Kinds

| Kind           | Fields                                                                            | Effect                                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `comment`      | `body`, optional `under`                                                          | [Reply](#comments) where a person spoke                                                                                                       |
| `label`        | `add`, `remove`                                                                   | Change labels, except trigger labels                                                                                                          |
| `push`         | `branch`, `message`                                                               | [Commit and push](#pushes) the checkout                                                                                                       |
| `pull_request` | `branch`, `base`, `title`, `body`                                                 | Open a pull request, or update the open one for that branch                                                                                   |
| `merge`        | `number`, `head`                                                                  | Merge the run's pull request if its head still matches                                                                                        |
| `issue`        | `relation`, `title`, `body`; parts add `size`, optional `stacks_on`, `depends_on` | [File an issue](#filing-issues)                                                                                                               |
| `ask`          | `question`                                                                        | Post a question and wait                                                                                                                      |
| `ask`          | `runner`                                                                          | Report a sandbox, checkout, network or tool problem; the engine handles it as a [runner error](workflows.md#order-and-limits) and asks no one |
| `back`         | `why`                                                                             | [Return to an earlier step](workflows.md#tries-and-going-back)                                                                                |
| `run`          | `workflow`, `issue`, optional `step`                                              | [Dispatch](workflows.md#dispatch) a workflow and wait                                                                                         |
| `tell`         | `issue`, `text`                                                                   | [Forward text](workflows.md#routing) to a live run                                                                                            |

An agent's `returns` lists the kinds it may use, plus `ask`, and `back` on a step with `back`. A `run` step's own `returns` limits what its script prints, `ask` and `back` included, by default to `run`; see [Gates](workflows.md#gates). The engine owns two more kinds: `react` and `rebase`. <!-- code: src/proposal.ts#React src/proposal.ts#Rebase src/proposal.ts#Said -->

## Applying

1. `ask` waits at once; checks and other proposals are skipped.
2. Checks run. A blocking failure fails the try.
3. `back` returns to its step, and nothing else applies.
4. Otherwise `tell`, then pushes, then the other writes in order, then `issue` filings. A failed push skips the writes after it, except a reply in a review thread: it still answers the person, with a line saying the push failed and its changes are not on the pull request yet. `run` dispatches last, only when nothing failed.

A missing block, invalid JSON, wrong fields or a kind the step may not use fails the try, with the expected shape as feedback. A kind it may not use fails the try before anything applies, an `ask` included. <!-- code: src/run/attempt.ts#runAttempt -->

A refused write fails the try. Any other GitHub error is a [runner error](workflows.md#order-and-limits), never a question to the person. The try's sessions are kept, so the retry resumes them. A push that hits such an error still lets the thread replies after it post first.

## Comments

An agent posts only the kinds its `returns` lists, so a reviewer that returns `[back]` keeps its findings in the run: a pass leaves its reply in the trace, and `back` passes its findings to the step it returns to. This stays within the run; see [Retros](workflows.md#retros) for the `feedback` trigger. <!-- code: src/workflow.ts#transition -->

A comment goes where a person started or woke the run, else to the branch's open pull request, else the issue. `under` names a review comment to reply under, on the pull request that holds it. Timelines and change requests show each review comment with the id of its thread's first comment, the one to reply under. A top-level comment that answers a review comment links it. When people spoke in several places, a comment without `under` posts once, at top level if one of them was. <!-- code: src/run/settle.ts#writeProposals -->

## Pushes

`push` and `pull_request` must name the run's own `agentgraph/` branch. A push is refused if the branch moved since the checkout last saw it, and never forces except to finish a [rebase](workflows.md#when-the-base-or-the-graph-moves).

While the branch has no open pull request, an agent that may return `pull_request` must return one, or an `ask`, a `back`, an `issue` part, or comments answering a finished run. <!-- code: src/run/attempt.ts#runAttempt -->

A `pull_request` on a branch whose pull request is open rewrites its title and body. The description ends with a [⁂ run link](runs.md#run-links) to the trace entry that wrote it, and the engine puts its [status header](workflows.md#status-on-the-issue) back on top after the step. A step of its own after review, with an agent that returns only `pull_request`, keeps the description current each time the change goes round again. <!-- code: src/tracker.ts#folderTracker src/github.ts#githubTracker -->

A push takes at most 200 regular files of 1 MiB each. Changes under `.github/` are left out and listed in the pull request for a maintainer. GitHub's Git API writes and signs the commits. <!-- code: src/tracker.ts#unpushable -->

Both trackers report held paths in the push result's `held` list, recorded in the trace. The first push holding a path on a branch is incomplete (`ok: false`), even if other files were pushed; its reason tells the agent what landed before it can post replies. Later pushes still list that held path but succeed unless another failure occurs. A held-only push says nothing was pushed and has no `url`. Mixed pushes include the new commit's `url`. After a newly held path, later proposals wait for a corrected reply or an ask. <!-- code: src/event.ts#Applied src/tracker.ts#makePushResult src/run/settle.ts#writeProposals -->

## Filing issues

Every `issue` body ends with a `## Done when` section of one to three observable checks.

| `relation`  | Files                                                                                                           | Label         |
| ----------- | --------------------------------------------------------------------------------------------------------------- | ------------- |
| `part`      | A sub-issue in landing order, with a `size`: `XS`, `S`, `M`, `L` or `XL`                                        | `size/<size>` |
| `follow-up` | Work outside the issue, ending with `Found while working on #n`; it runs only once someone adds a trigger label | `follow-up`   |
| `graph`     | A recurring miss and the check or prompt that would catch it                                                    | `graph`       |

<!-- code: src/run/start.ts#createIssues -->

The parent gets a `Split into:` comment with a task list. Each `XL` part starts the same workflow again. A follow-up or graph issue whose title matches an open one becomes a comment there. Filing uses a token limited to `issues: write`. <!-- code: src/run/start.ts#readFiledIssues src/github.ts#scopes -->

One refused filing fails the try and files nothing. The engine refuses a body without `## Done when`, any filing while an outsider's issue text is withheld, a part whose title matches an open issue, a reference to anything but an earlier part, and parts of an issue already three levels deep (`deepest`). <!-- code: src/run/start.ts#deepest -->

### Stacks on and Depends on

`stacks_on` names one earlier part by position, from 1, and `depends_on` lists earlier positions. The engine writes them as `Stacks on #n` and `Depends on #n` lines; on an existing issue, write the line yourself.

With `stacks: true` in `settings.yaml`, `Stacks on #n` builds on #n's open pull request or workflow branch, targets it, and registers a GitHub stack where the repo supports it. <!-- code: src/run/drive.ts#findStackBase src/github.ts#githubTracker -->

A workflow with a `branch` holds a run, `running` but not driven, until every `Depends on #n` issue is closed and every `Stacks on #n` issue has a pull request. A held run says what it waits for as its reason, such as `until #24 closes`, which run lists print; the issue shows `working`. When a stacked parent's head moves, the child rebases onto it; a conflict asks for a manual rebase. <!-- code: src/run/trigger.ts#findHold src/run/follow.ts#runFollow -->

### The triage example

`examples/sandbox` sizes and splits issues with graph files alone. `workflows/triage.md` starts on the `triage` label or a dispatch. Its triager reads code and returns `label`, `issue` or one `ask` of at most six questions; it never implements, merges or closes. The blocking `checks/sized.md` wants one size label, or a split into smaller parts.
