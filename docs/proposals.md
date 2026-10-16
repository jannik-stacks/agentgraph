# Proposals

What an agent asks the engine to do, and the only write path from an agent to GitHub.

An agent never holds a GitHub token, and it is told not to run `git` or `gh`. It ends its reply with a fenced `bothub` block, and the engine reads the last such block: a
JSON array, or one JSON object per line.

````md
```bothub
[
  {"kind": "push", "branch": "bothub/42", "message": "Fix fee rounding"},
  {"kind": "pull", "branch": "bothub/42", "into": "main", "title": "Fix fee rounding", "body": "Closes #42"}
]
```
````

## Kinds

| Kind    | Fields                          | Effect                                                         |
| ------- | ------------------------------- | -------------------------------------------------------------- |
| `reply` | `body`                          | Comments on the issue                                          |
| `label` | `add`, `remove`                 | Changes labels                                                 |
| `push`  | `branch`, `message`             | Commits the checkout and pushes the branch                     |
| `pull`  | `branch`, `into`, `title`, `body` | Opens a pull request, or finds the one already open          |
| `merge` | `number`, `head`                | Merges a pull request, only while its head is still `head`     |
| `issue` | `title`, `body`, `parent`       | Opens an issue, as a sub-issue of `parent` when given          |
| `ask`   | `question`                      | Posts the question and makes the run wait                      |
| `back`  | `why`                           | Sends the run back, see [The loop](loop.md#back)               |

`ask` and `back` steer the run. They never reach GitHub as writes.

## Returns

`returns` in an agent file lists the kinds it may propose, `reply` alone by default. Every agent may
also `ask`, and a step with `back` lets its agent `back`. The prompt shows the agent the shape of
each kind it may use.

```yaml
returns: [reply, push, pull, ask]
```

## Validation

A reply that needs proposals and has no `bothub` block fails the try, and so does a block that is
not valid JSON or has a kind with the wrong fields. The failure goes back as feedback with the
expected shape. A proposal of a kind the agent may not make is refused with a reason, and also
fails the try.

## Applying

Proposals are applied only after the step's checks pass. Pushes go first, then the rest in order.
Each one is traced with its result: the URL it made, or why it was refused, for example a merge of a
pull request that moved, or a pull request whose branch was never pushed. A refused proposal fails
the try with that reason as feedback. A push never forces.
