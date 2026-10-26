# Proposals

Agents have no GitHub token and are told not to run `git` or `gh`. They ask the engine for writes with proposals.

A reply ends with a fenced `agentgraph` block. The engine reads the last one as a JSON array, one object, or one object per line. <!-- code: src/engine.ts#parseProposals -->

```agentgraph
[
  {"kind": "push", "branch": "agentgraph/42", "message": "Fix fee rounding"},
  {"kind": "pull_request", "branch": "agentgraph/42", "base": "main", "title": "Fix fee rounding", "body": "Closes #42"}
]
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

An agent's `returns` lists the kinds it may use. Every agent may also `ask`, and a step with `back` allows `back`. The prompt shows each allowed shape. The engine owns two more kinds: `react` for eyes reactions and `rebase` for base updates. <!-- code: src/proposal.ts#React src/proposal.ts#Rebase src/proposal.ts#Said -->

## Applying

1. `ask` waits at once, even beside invalid proposals. Checks and the other proposals are skipped.
2. Checks run. A blocking failure fails the try, and nothing applies.
3. `back` returns to its step, and nothing else applies.
4. Otherwise `tell` is delivered, then pushes land, then the other writes in order, then `issue` filings. A failed push skips the filings. `run` dispatches last, and only when nothing failed.

A missing block, invalid JSON, wrong fields, or a kind the agent may not use fails the try. The feedback shows the expected shape and asks for every proposal again. <!-- code: src/engine.ts#attempt -->

The trace records each applied proposal with its URL or why it failed. A refused write fails the try with feedback. Any other GitHub error parks the run with a question.

## Comments

A comment goes where the person started or woke the run: the issue, the pull request or a review thread. With no such place it goes to the open pull request of the run's branch, else the issue. `under` names a review comment id to reply under. When the person spoke in several places, a comment without `under` posts once: at top level if one of them is, else under the newest thread. <!-- code: src/engine.ts#land -->

## Pushes

`push` and `pull_request` must name the run's own branch, which starts with `agentgraph/`. If the branch moved since the checkout started or last pushed, the push is refused. Pushes never force, except the one that finishes a [rebase](workflows.md#when-the-base-or-the-graph-moves).

While no pull request is open for the branch, a try of an agent that may return `pull_request` passes only with a `pull_request`, an `ask`, a `back`, an `issue` part, or comments that answer a finished run. <!-- code: src/engine.ts#attempt -->

A push takes regular files outside `.git/`, at most 200 files of 1 MiB each. Changes under `.github/` are left out and listed in the pull request for a maintainer to push. GitHub's Git API writes and signs the commits. <!-- code: src/forge.ts#unpushable -->

## Filing issues

An `issue` proposal's `relation` says what it files. Every body ends with a `## Done when` section of one to three observable checks.

| `relation` | Files | Label |
| --- | --- | --- |
| `part` | A sub-issue of the current issue, with a `size` from `XS` to `XL`. Propose parts in landing order. | `size/<size>` |
| `follow-up` | Work outside the current issue. It has no parent or milestone, ends with `Found while working on #n`, and starts no run until someone adds a trigger label. | `follow-up` |
| `graph` | A follow-up about the graph: the recurring miss and the check, lint or prompt that would catch it | `graph` |

<!-- code: src/engine.ts#file -->

The parent gets a `Split into:` comment with a task list; its body stays as it was. Each `XL` part starts the same workflow again. A follow-up or graph change whose title matches an open one becomes a comment there. Agents that may file issues see the open follow-up and graph titles. Filing uses a token limited to `issues: write`. <!-- code: src/engine.ts#filed src/github.ts#scopes -->

One refused filing files none of the issues and fails the try. The engine refuses:

- a body without `## Done when`
- any filing while the issue's text is withheld because an outsider wrote it
- a part whose title matches an open issue
- a part reference to anything but an earlier part
- parts of an issue already three levels deep (`deepest`); split it by hand <!-- code: src/engine.ts#deepest -->

### Stacks on and Depends on

`stacks_on` names one earlier part by position, counting from 1, and `depends_on` lists earlier positions. The engine writes `Stacks on #n` and `Depends on #n` lines with the new issue numbers. For an existing issue, write the `Depends on #<number>` line yourself.

With `stacks: true` in `settings.yaml`, `Stacks on #n` builds on the open pull request of #n, or its workflow branch. The new pull request targets that branch, and the engine registers the chain as a GitHub stack where the repo supports it. <!-- code: src/engine.ts#findStackBase src/github.ts#githubForge -->

A workflow with a `branch` holds a run until every `Depends on #n` issue is closed and every `Stacks on #n` issue has a pull request. Both must be lines of their own. A held run stays `running` but is not driven. When a stacked parent's head moves, the child rebases onto it; a conflict asks for a manual rebase. <!-- code: src/engine.ts#pending src/engine.ts#follow -->

### The triage example

`examples/sandbox` sizes and splits issues with graph files alone. `workflows/triage.md` starts on the `triage` label or a dispatch. `agents/triager.md` reads code with `read`, `grep` and `glob`, and returns `label`, `issue` and `ask`. The blocking `checks/sized.md` script wants one size label, or a split whose parts are all smaller.

| Size | Scope |
| --- | --- |
| `XS` | A line or two |
| `S` | A small edit |
| `M` | One function and its test |
| `L` | One pull request, reviewable in one sitting |
| `XL` | Split into parts |

What the triager still needs after reading goes into one `ask` of at most six numbered questions. Triage never implements, merges or closes anything.
