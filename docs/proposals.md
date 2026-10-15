# Proposals

What a run returns, and the only write path from a bot to GitHub or the hub.

A bot never holds a GitHub token and never writes the hub, which is mounted read-only. Its run
ends when it returns: it ends its final message with a fenced `bothub` block, and bothub reads
proposals from the last such block (`extractProposals`): a JSON array or
one JSON object per line. The full type is `Proposal`.

````md
```bothub
{"kind": "push", "branch": "bothub/42-fix-fee", "files": ["kit/src/fee.ts"]}
{"kind": "merge-request", "title": "Fix fee rounding", "body": "Closes #42", "branch": "bothub/42-fix-fee"}
```
````

## Kinds

| Kind            | Fields                                     | Effect                                                   |
| --------------- | ------------------------------------------ | -------------------------------------------------------- |
| `reply`         | `body`                                     | Comments on the issue or pull request                    |
| `label`         | `add`, `remove`                            | Changes labels                                           |
| `push`          | `branch`, `files`                          | Pushes the run's branch                                  |
| `merge-request` | `title`, `body`, `branch`, `into`, `draft` | Asks to merge a branch: a pull request on GitHub         |
| `merge`         | `request`                                  | Merges an open request into the job's `into`             |
| `note`          | `note`, `slug`, `title`, `body`            | Proposes a note under `notes/` with status `proposed`    |
| `hub`           | `title`, `body`, `files`                   | Proposes whole hub files, or deletes them                |
| `ask`           | `question`                                 | Asks a human and waits                                   |
| `close`         | `as`, `reason`, `resolved`                 | Says the job stopped short of done, and why              |

## Returns

`returns` on a bot is the most it may return, and a job narrows it. Each entry is a kind from the
table, or `hub(<globs>)` for changes to hub files matching the globs.

```yaml
returns: [reply, merge-request, note, hub(notes/**, skills/**)]
```

`note` is the convenient form of a hub change: one new note, which an opencode run can also
propose while it works with the `notes_add` tool. A run that returns a hub change ends there;
checks then judge the run, and a failing check sends it back for another try.

## Hub changes

The hub is code. A `note` or `hub` proposal lands as a commit on a new branch of the hub's own
repository, `bothub/hub/<slug>-<sha>`, for a human to review and merge. The working tree and the
checked-out branch are never touched, and a change that would leave the hub invalid is refused.
A hub that is not the top of its own repository gets nothing, and the proposal is skipped.

`hub.yaml`, `bots/` and `workflows/` change only by a human. A `hub(...)` glob that could reach
them is a config error, and a proposal that touches them is rejected and never applied, whatever
the bot returns.

## Validation

Every proposal is checked by `validate` before anything happens, and anything not
explicitly allowed is rejected with a reason.

- The kind must be in the job's effective `returns` (the job's own `returns`, narrowed by the bot's).
- Every file of a `hub` proposal must match one of the returned globs.
- A push must be to the job's rendered `branch`, and every file it changed since the run started
  must be listed in `files` and match the job's `paths`.
- A merge request must come from a `bothub/` branch, the job's `branch` when it has one, and go
  into the job's rendered `into` or the default branch. Leaving `into` out means the job's `into`,
  or the default branch when the job has none. A branch never goes into itself.
- A `close` is always allowed. With `resolved: true` it says the issue already has what it asks
  for: it must be `no-op` and the job must return `reply`, and its reason is posted on the issue,
  which is then closed. Jobs that need this one do not run.
- At most three replies, three notes and one of every other kind per run.

Accepted proposals are applied by `apply` only after the job's checks pass, only when the job is not in
`log`, and only when bothub has a GitHub App to act as. Pushes go first, then the rest in
order. A merge request whose branch failed to push is skipped, and one already open for the
branch is found instead of opened twice. Pushes never force.

## Merging

A job that returns `merge` lands requests into its `into`. Requests go into a branch that is
created from the default branch when the first step starts or the first request opens, so a
plan's steps can each have a branch of their own and still meet on one. A step's new branch
starts from its `into`, so it builds on the steps that already landed:

```yaml
implement:
  type: bot
  bot: implementor
  skill: implement
  branch: bothub/{parent}-{issue}
  into: bothub/{parent}
  returns: [reply, push, merge-request, ask]
merge:
  type: script
  run: node "$BOTHUB_HUB/scripts/merge-next.mjs"
  into: '{base}'
  requires: [types, tests]
  returns: [merge, merge-request]
```

The step branch cannot sit inside its `into` (`bothub/5/6` next to `bothub/5`), since git cannot
hold both refs; the config check says so.

````md
```bothub
{"kind": "merge", "request": 12}
```
````

A merge lands only for an open request from a `bothub/` branch whose `into` is the job's. The
runner merges the two tips without a worktree, runs the job's `requires` checks on the merged
tree, and moves `into` only if neither tip moved since; on GitHub that is the pull request's
merge with the head it checked. A request whose merge conflicts goes back once to the job that
opened it: the job runs again on its branch with `into` merged in and the conflict markers in
place, its bot gets a `## Merge conflicts` section listing the files, and its push commits the
merge. Markers left in a conflicting file count as a failing check. Once a request lands, `into`
is merged forward into every other open request into it that merges cleanly, so their checks and
merges see the current plan; a branch a running job holds, or one that conflicts, is left as it is.

A landed request also closes the step issue its job ran for and posts one line on the plan, such
as `#3 landed on bothub/1, 2 of 4 steps.` The merging run reads `running` until the merge has
landed or failed, and only then stores its status and closure.

A script job that returns `merge` is skipped as a no-op, without a worktree, when no request from
a `bothub/` branch is open into its `into` and there is no request left to open from `into`: it
is the default branch, the job cannot return `merge-request`, or that request is already open.

Only a human merges into the default branch. `hub.yaml` can hand that to bots, and a job that
returns `merge` without `into` is a config error until it does:

```yaml
merge:
  default-branch: human # or bots
```

The body of a merge request is the bot's text, followed by what the engine adds. `merge-request`
in `hub.yaml` lists those sections, in order, from `closes` (a `Closes #N` line, or `Part of #N`
when the brief has `Follow-up:` lines, added only if missing), `criteria` (a table of each
criterion and its test), `checks` (how many checks passed, and the `warn` and `log` ones that did
not) and `gaps` (the known gaps). The brief is the issue's latest comment with a `## Criteria`
heading; `criteria` reads its numbered lines that end in `Test: it('<title>')`. The default is
`[closes, checks, gaps]`; `[]` leaves the bot's body as written.

```yaml
merge-request:
  sections: [closes, gaps]
```

A script job that returns `merge` gets the open requests into its `into` as JSON in
`BOTHUB_REQUESTS`, along with `BOTHUB_INTO` and `BOTHUB_DEFAULT_BRANCH`. `BOTHUB_STEPS` lists the
sub-issues of the plans whose requests go into `into`, each with its `state`, its plan as `parent`,
whether a request it opened was `merged` there and whether a job on it is `running` (queued or
running), so a script can wait for the whole plan before asking to merge it. A script proposes by
printing a `bothub` block, the same way a bot does.

Every outcome, accepted, rejected and applied, is stored in the run's `outcome.json` as an

`Outcome` and shown in the studio. Each effect is journalled before it is applied, so a retry never
repeats one; the code is on [Proposals and apply](reference/proposals.md).
