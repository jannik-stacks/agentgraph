# Events and serving

Where events come from, the long-running hubs, and running whole workflows without a model.

Everything starts from a `BotEvent`. A GitHub delivery is checked by `webhook` and normalised by
`toEvent`. Locally, `bothub say --issue <n> "text"` posts a comment into the file forge and the runner
hears it the way it hears a GitHub comment.

The fields are on `BotEvent` in [src/types.ts](../../src/types.ts).

## Serving

`bothub serve --hub <dir>` picks its source from `hub.yaml`. With `issues: local` it is

`serveHub`: it plays GitHub's part with the local bare repository given as `--repo` and serves the
read-only `api` that BHM reads, with the operator ops under `POST /rpc/<op>` (see `ops` in
[src/ops.ts](../../src/ops.ts)). Otherwise it is `serveGitHub`, the same for a GitHub App, with short-lived
installation tokens that no bot ever holds. Both start each event's work on one `runner`, which runs it
through `handleEvent` and the [pipeline](pipeline.md).

Nothing is polled. A message starts work when it arrives; a merge request a bot opened starts its
`pull_request` workflows once the event that opened it is done.

## Assignment and lanes

Work is assigned with a label. On GitHub, adding `bot:implementor` to an issue emits an `issues` event with
action `labeled` and that label, one event per added label, the same shape a GitHub delivery
has. A workflow picks it up with a `labels` filter next to `types`:

```yaml
on:
  issues:
    types: [labeled]
    labels: [bot:implementor]
```

The `bot:` prefix is a convention, not a keyword: any label works, and the same workflow runs
unchanged on GitHub.

Every label and close bothub makes on a local issue is recorded under the issue's `changes` with
who made it.

The runner keeps one lane per issue or merge request in memory and never runs two events of one
lane at once, so the events of one issue run in the order they came. Up to `--concurrency` step
sessions run at once across all events, 4 unless set, and check sessions have a pool of the same
size of their own, so an attempt's reviewers never wait behind other issues' implementors. A bot's
`sessions` in `hub.yaml` `limits` caps its own sessions, steps and checks together, within those pools; several sessions
on one provider key can set it to queue in bothub rather than at the model. An event a bot made
that starts no step is logged and never run.

`bothub pause` holds new work in `<data>/runner.json` until `bothub resume`; `--now` also stops what
is running and holds it. When `serve` starts, runs a stopped process left unfinished are marked
interrupted and their event runs again, reusing every job that finished.

A hub edit that does not compile is logged once, and events keep running with the last version
that compiled until it is fixed; `/api/info` lists its errors as `hubErrors` meanwhile. A hub that
never compiled runs nothing.

`serve` logs each check as it starts and ends, with its verdict and how long it took:

```text
issue/implement 2026-10-13T10-27-07-656Z-9693d9 check tests start
issue/implement 2026-10-13T10-27-07-656Z-9693d9 check tests pass in 41.3s
```

Each job's result is logged as that job ends, not once the whole event is done:

```text
issue/implement: succeeded, done 2026-10-13T10-27-07-656Z-9693d9
```

A job already running is stopped as withdrawn when its label is removed or its issue closed. bothub
adds no status labels of its own; once work starts, its runs carry their status and closure.

See `runner` in [src/serve.ts](../../src/serve.ts).

## Merge requests

Locally, the bare origin plays GitHub's part for merge requests too (`localPulls`).
Each request is a line appended to `<data>/pulls.jsonl`, one per change, and the current state is
folded from them on read:

```jsonl
{"ts":"…","number":1,"op":"open","branch":"bothub/5-6","into":"bothub/5","title":"Add cvToJson","body":"Closes #6.","job":"plan/implement","event":"local-6-comment-1-…","sha":"9dd7e50…"}
{"ts":"…","number":1,"op":"update","sha":"41c2a07…"}
{"ts":"…","number":1,"op":"merge","sha":"c03b1f2…","into-sha":"5e0d9aa…"}
```

Opening a request creates its `into` from the default branch when it does not exist yet and
mirrors the branch to `refs/pull/<n>/head`, like GitHub. A request's head is its branch's live
commit, whether it merges cleanly is answered by `git merge-tree`, and a merge is `merge-tree`,
`commit-tree` and an `update-ref` that only succeeds while `into` is still where the merge was
checked. `serve` turns the log into `pull_request` events, `opened`, `synchronize` when a branch
moved and `closed` once merged, by `bothub[bot]`, so a workflow can trigger on them just as on
GitHub. A comment on a request is a `comment` line in the same log, and `bothub say --pull <n> "text"` adds one.

GitHub's pull requests sit behind the same `Pulls` interface (`githubPulls`),
so the pipeline never knows which one it talks to. What GitHub adds is the review UI, comments and
labels on pull requests, and requests from forks.

## Sim

`bothub sim <scenario>` runs a hub against scripted human actions, one after another. Bots are
replaced by a scripted harness and checks by scripts that pass or fail as told; the repository is
a real local bare origin, and planning, the pipeline, the MCP server, validation, apply and the
local merge requests are real. The `pull_request` events that follow run until none are left, and
`expect` names the merge requests the scenario must end with. `simulate` runs one.

The fields are on `Scenario` in [src/sim.ts](../../src/sim.ts).
