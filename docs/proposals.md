# Proposals

What an agent asks the engine to do, and the only write path from an agent to GitHub.

An agent has no GitHub token and does not run `git` or `gh`. It ends its reply with a fenced `bothub`
block, and the engine reads the last such block: a JSON array, or one JSON object per line.

````md
```bothub
[
  {"kind": "push", "branch": "bothub/42", "message": "Fix fee rounding"},
  {"kind": "pull_request", "branch": "bothub/42", "base": "main", "title": "Fix fee rounding", "body": "Closes #42"}
]
```
````

## Kinds

| Kind           | Fields                            | Effect                                                     |
| -------------- | --------------------------------- | ---------------------------------------------------------- |
| `comment`      | `body`                            | Comments on the issue, or where a human last spoke         |
| `label`        | `add`, `remove`                   | Changes labels                                             |
| `push`         | `branch`, `message`               | Commits the checkout and pushes the branch                 |
| `pull_request` | `branch`, `base`, `title`, `body` | Opens a pull request, or finds the one already open        |
| `merge`        | `number`, `head`                  | Merges a pull request, only while its head is still `head` |
| `issue`        | `title`, `body`, `parent`         | Opens an issue, as a sub-issue of `parent` when given      |
| `ask`          | `question`                        | Posts the question and makes the run wait                  |
| `back`         | `why`                             | Sends the run back, see [The loop](loop.md#back)           |

## Returns

`returns` in an agent file lists the kinds it may propose, `comment` alone by default. Every agent may
also `ask`, and a step with `back` lets its agent `back`. The prompt shows the agent the shape of
each kind it may use.

```yaml
returns: [comment, push, pull_request, ask]
```

## Validation

A reply that needs proposals and has no `bothub` block fails the try, and so does a block that is
not valid JSON or has a kind with the wrong fields. The failure goes back as feedback with the
expected shape. A proposal of a kind the agent may not make fails with a reason, and so does the try.

## Applying

Proposals are applied only after the step's checks pass. Pushes go first, then the rest in order.
Each is traced with its URL, or the reason it failed. A failed proposal fails
the try with that reason as feedback. A push never forces.
