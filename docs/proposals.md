# Proposals

What an agent asks the engine to do, and the only write path from an agent to GitHub.

An agent has no GitHub token and does not run `git` or `gh`. It ends its reply with a fenced `bothub` block. The engine reads the last such block: a JSON array, one JSON object, or one JSON object per line (`code: src/engine.ts#proposalsOf`).

````md
```bothub
[
  {"kind": "push", "branch": "bothub/42", "message": "Fix fee rounding"},
  {"kind": "pull_request", "branch": "bothub/42", "base": "main", "title": "Fix fee rounding", "body": "Closes #42"}
]
```
````

## Kinds

| Kind           | Fields                                                         | Effect                                                           |
| -------------- | -------------------------------------------------------------- | ---------------------------------------------------------------- |
| `comment`      | `body`                                                         | Comments where a human last spoke, see below                     |
| `label`        | `add`, `remove`                                                | Changes the issue's labels                                       |
| `push`         | `branch`, `message`                                            | Commits the checkout and pushes the branch                       |
| `pull_request` | `branch`, `base`, `title`, `body`                              | Opens a pull request                                             |
| `merge`        | `number`, `head`                                               | Merges a pull request, only while its head is still `head`       |
| `issue`        | `title`, `body`, `size`, `priority`, `stacks_on`, `depends_on` | Files a sub-issue of the run's issue, see [Sub-issues and stacks](stacks.md)    |
| `ask`          | `question`                                                     | Posts the question and makes the run wait                        |
| `back`         | `why`                                                          | Sends the run back, see [The loop](loop.md#tries-and-going-back) |

The engine also uses two kinds of its own that no agent may propose: `react` puts the eyes emoji on the comment that woke a run, and `rebase` moves a stacked branch onto its parent's new head (`code: src/forge.ts#Proposal`).

## Where a comment goes

A comment goes where the human who started or woke the run spoke: the issue, or its pull request. When that was a review comment on a line, the reply goes into that review thread. When no human spoke yet, it goes on the open pull request of the run's branch, else on the issue (`code: src/engine.ts#land`).

## Returns

`returns` in an agent file lists the kinds it may propose. The default is `comment` alone.

Every agent may also `ask`, and a step with `back` lets its agent `back`.

The prompt shows the agent the shape of each kind it may use.

```yaml
returns: [comment, push, pull_request, ask]
```

## Validation

These fail the try:

- An agent's reply without a `bothub` block.
- A block that is not valid JSON.
- A kind with missing or extra fields.
- A proposal of a kind the agent may not make, with a reason.

The failure goes back as feedback, with the expected shape.

## Applying

An `ask` makes the run wait at once: no checks run and nothing else in the block is applied.

Other proposals are applied only after the step's checks pass. A `back` then sends the run back, and nothing else is applied. Otherwise pushes go first, then the rest in order (`code: src/engine.ts#attempt`).

Each proposal is traced with its URL, or the reason it failed. A failed proposal fails the try, with that reason as feedback. On GitHub, a second pull request for the same branch is refused that way.

## Pushes

A push never forces. It goes to a branch starting with `bothub/` and builds on the commit the checkout started from, or on its own last push. When the branch moved meanwhile, the push is refused.

Only regular files outside `.github/` and `.git/` can be pushed, at most 200 files and 1 MiB per file. GitHub signs the commits, because the engine writes them through GitHub's Git API (`code: src/github.ts#unpushable`).
