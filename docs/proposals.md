# Proposals

Agents have no GitHub token and are told not to run `git` or `gh`. They ask the engine for writes with proposals.

A reply ends with a fenced `agentgraph` block. The engine reads the last one as a JSON array, one object, or one object per line. <!-- code: src/engine.ts#proposalsOf -->

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
| `label` | `add`, `remove` | Change labels, except workflow trigger labels |
| `push` | `branch`, `message` | [Commit and push](#pushes) the checkout |
| `pull_request` | `branch`, `base`, `title`, `body` | Open a pull request, or update the open one for that branch |
| `merge` | `number`, `head` | Merge the run's pull request if its head still matches |
| `issue` | `relation`, `title`, `body`; parts add `size`, `priority`, optional `stacks_on`, `depends_on` | File a [part, follow-up or hub change](stacks.md) |
| `ask` | `question` | Post a question and wait |
| `back` | `why` | [Return to an earlier step](loop.md#tries-and-going-back) |
| `run` | `workflow`, `issue`, optional `step` | [Dispatch](loop.md#dispatch) a workflow and wait |
| `tell` | `issue`, `text` | [Forward text](loop.md#routing) to a live run |

An agent's `returns` lists the kinds it may use. Every agent may also `ask`, and a step with `back` allows `back`. The prompt shows each allowed shape.

The engine owns two more kinds that agents cannot propose: `react` for eyes reactions and `rebase` for stack and base updates. <!-- code: src/proposal.ts#React src/proposal.ts#Rebase src/proposal.ts#Said -->

## Applying

1. `ask` waits at once, even beside invalid proposals. Checks and the other proposals are skipped.
2. Checks run. A blocking failure fails the try and nothing applies.
3. `back` returns to its step and nothing else applies.
4. Otherwise `tell` is delivered, then pushes land, then the other writes in order, then `issue` filings. A failed push skips the filings. `run` dispatches last, and only when nothing failed.

A missing block, invalid JSON, missing or extra fields, or a kind the agent may not use fails the try. The feedback shows the expected shape and asks for every proposal again. Nothing from a malformed reply applies. <!-- code: src/engine.ts#attempt -->

The trace records each applied proposal with its URL or the reason it failed. A refused write fails the try with feedback. Any other GitHub error parks the run with a question.

## Comments

A comment goes where the person started or woke the run: the issue, the pull request or a review thread. With no such place it goes to the open pull request of the run branch, otherwise the issue.

`under` names a review comment id from the context to reply under. When the person spoke in several places, a comment without `under` posts once: at top level if one of them is, otherwise under the newest thread. <!-- code: src/engine.ts#land -->

## Pushes

`push` and `pull_request` must name the run's own branch, which starts with `agentgraph/`. The branch must still be where the checkout started or last pushed; if it moved, the push is refused. Pushes never force, except the one push that finishes a [rebase](loop.md#when-the-base-or-the-hub-moves).

A push takes regular files outside `.git/`, at most 200 files of 1 MiB each. Changes under `.github/` are left out and listed in the pull request for a maintainer to push. GitHub's Git API writes and signs the commits. <!-- code: src/forge.ts#unpushable -->
