# Proposals

A proposal is a change an agent asks the engine to make. It is the only way an agent writes to GitHub: the agent has no GitHub token and does not run `git` or `gh`.

The agent ends its reply with a fenced `bothub` block. The engine reads the last such block, as a JSON array, one JSON object, or one JSON object per line. <!-- code: src/engine.ts#proposalsOf -->

```bothub
[
  {"kind": "push", "branch": "bothub/42", "message": "Fix fee rounding"},
  {"kind": "pull_request", "branch": "bothub/42", "base": "main", "title": "Fix fee rounding", "body": "Closes #42"}
]
```

## Kinds

| Kind           | Fields                                                                                    | Effect                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `comment`      | `body`                                                                                    | Comments where a human last spoke, see [Comments](proposals.md#comments)                |
| `label`        | `add`, `remove`                                                                           | Changes the issue's labels, but never adds a label that starts a workflow               |
| `push`         | `branch`, `message`                                                                       | Commits the checkout and pushes the branch, see [Pushes](proposals.md#pushes)           |
| `pull_request` | `branch`, `base`, `title`, `body`                                                         | Opens a pull request                                                                    |
| `merge`        | `number`, `head`                                                                          | Merges a pull request, only while its head is still `head`                              |
| `issue`        | `relation`, `title`, `body`, and for a part `size`, `priority`, `stacks_on`, `depends_on` | Files a part, a follow-up or a hub change, see [Sub-issues and stacks](stacks.md)       |
| `ask`          | `question`                                                                                | Posts the question and makes the run wait                                               |
| `back`         | `why`                                                                                     | Sends the run back, see [The loop](loop.md#tries-and-going-back)                        |
| `run`          | `workflow`, `issue`, optional `step`                                                      | Starts a workflow with `on: dispatch` by name and waits on it, see [Dispatch](loop.md#dispatch); it never runs a command |
| `tell`         | `issue`, `text`                                                                           | Passes text to the live run on the issue as if a maintainer said it, see [Routing](loop.md#routing) |

`returns` in the agent file lists the kinds it may propose, `comment` alone by default. Every agent may also `ask`, and a step with `back` lets its agent `back`. The prompt shows the agent the shape of each kind it may use.

```yaml
returns: [comment, push, pull_request]
```

## Applying

```
 the agent's reply
   │
   ├──> ask: the run waits at once, with no checks and nothing else applied
   │
   ├──> a check fails: nothing is applied and the try fails
   │
   ├──> back: the run goes back and nothing else is applied
   │
   └──> otherwise: pushes first, then the rest in order
```

The try also fails, with the expected shape as feedback, when the reply has no `bothub` block, the block is not in one of the forms above, a proposal has missing or extra fields, or the agent may not make that kind. Nothing from such a reply is applied, and the feedback says to send every proposal again. <!-- code: src/engine.ts#attempt -->

Each applied proposal is traced with its URL, or the reason it failed. A failed proposal fails the try, and the reason goes back as feedback. On GitHub, a second pull request for the same branch fails this way.

## Comments

A comment goes where the human who started or woke the run spoke: the issue, its pull request, or the review thread of a line comment. When no human spoke yet, it goes on the open pull request of the run's branch, else on the issue. A comment with `under` answers the review comment with that id on the run's pull request; the agent's context shows each review comment's id. When people spoke in several places, a comment without `under` is posted once, at the top level if one of them is, else under the newest thread. <!-- code: src/engine.ts#land -->

## Pushes

A push never forces. Its branch starts with `bothub/`, and it builds on the commit the checkout started from or on its own last push. When the branch moved meanwhile, the push is refused.

Only regular files outside `.github/` and `.git/` are pushed, at most 200 files and 1 MiB per file. A change under `.github/`, such as a workflow, is left out of the push and the rest goes on; the pull request names the files left out, for a maintainer to push. The engine writes the commits through GitHub's Git API, so GitHub signs them. <!-- code: src/github.ts#unpushable -->

## Engine kinds

The engine makes two kinds of its own that no agent may propose: `react` puts the eyes reaction on the comment that woke a run, and `rebase` moves a stacked branch onto its parent's new head. <!-- code: src/forge.ts#Proposal -->
