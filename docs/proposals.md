# Proposals

Agents request GitHub writes through proposals. They have no GitHub token and are told not to run `git` or `gh`.

End the reply with a fenced `agentgraph` block. The engine reads the last block as a JSON array, one object, or one object per line. <!-- code: src/engine.ts#proposalsOf -->

```agentgraph
[
  {"kind": "push", "branch": "agentgraph/42", "message": "Fix fee rounding"},
  {"kind": "pull_request", "branch": "agentgraph/42", "base": "main", "title": "Fix fee rounding", "body": "Closes #42"}
]
```

## Kinds

| Kind | Fields | Effect |
| --- | --- | --- |
| `comment` | `body`, optional `under` | [Reply](#comments) where a human spoke |
| `label` | `add`, `remove` | Change labels; cannot add workflow trigger labels |
| `push` | `branch`, `message` | [Commit and push](#pushes) checkout files |
| `pull_request` | `branch`, `base`, `title`, `body` | Open a pull request |
| `merge` | `number`, `head` | Merge only if its head still matches |
| `issue` | `relation`, `title`, `body`; parts also use `size`, `priority`, optional `stacks_on`, `depends_on` | File a [part, follow-up or hub change](stacks.md) |
| `ask` | `question` | Post a question and wait |
| `back` | `why` | [Return to a configured step](loop.md#tries-and-going-back) |
| `run` | `workflow`, `issue`, optional `step` | [Dispatch](loop.md#dispatch) a workflow and wait |
| `tell` | `issue`, `text` | [Forward text](loop.md#routing) to a live run |

Agent `returns` selects allowed kinds, default `[comment]`. All agents may also `ask`; a step with `back` permits `back`. Prompts include allowed shapes.

## Applying

1. `ask` waits immediately, skipping checks and other proposals.
2. Checks run; blocking failures fail the try without applying proposals.
3. `back` returns without applying other proposals.
4. Otherwise, pushes land first, then remaining proposals in order.

Missing blocks, invalid JSON, missing or extra fields, and forbidden kinds fail the try. Feedback gives the expected shape and asks for all proposals again. Nothing from malformed replies applies. <!-- code: src/engine.ts#attempt -->

Each applied proposal records success and URL or failure reason. Failed writes fail the try with feedback. GitHub rejects a second pull request for the same branch.

## Comments

Comments answer the issue, pull request or review thread where the human started or woke the run. With no human source, they target the run branch's open pull request, otherwise the issue.

`under` targets a review comment id shown in context on the run's pull request. With several source locations, an untargeted comment posts once: at top level if present, otherwise under the newest thread. <!-- code: src/engine.ts#land -->

## Pushes

Agent pushes never force. Branches must start with `agentgraph/` and descend from the checkout's starting commit or last push. A branch moved meanwhile causes refusal.

Pushes allow regular files outside `.github/` and `.git/`, at most 200 files and 1 MiB each. `.github/` changes are omitted and listed in the pull request for a maintainer to push. GitHub's Git API writes and signs commits. <!-- code: src/github.ts#unpushable -->

## Engine kinds

Agents cannot propose `react` (eyes reactions) or `rebase` (stack and base updates). The engine owns these kinds. <!-- code: src/forge.ts#Proposal -->
