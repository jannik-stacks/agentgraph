# Runs

What a run records, and where.

A run is one workflow on one issue. Everything bothub keeps sits in one data directory, `BOTHUB_DATA`.

```
$BOTHUB_DATA/
  <run id>/run.json       where the run stands
  <run id>/trace.jsonl    one line per thing that happened
  mirror.git              a bare mirror of the repo
  work/<run id>/          the run's checkout, removed when it closes
  homes/<id>/             a session's private home: the harness's own history
  .locks/                 one lock file per run being driven
```

A run id is the workflow name, the issue number and a timestamp, so runs sort in the order they began.

## run.json

| Field      | Meaning                                                    |
| ---------- | ---------------------------------------------------------- |
| `workflow` | The workflow it runs                                       |
| `thread`   | The issue number                                           |
| `step`     | The step it is on                                          |
| `status`   | `running`, `asking`, `waiting`, `done` or `stopped`        |
| `tries`    | Tries used on this step                                    |
| `rounds`   | Times each step has gone back                              |
| `sessions` | The session of each step, so a try resumes it              |
| `feedback` | The feedback for the next try                              |
| `reason`   | Why the run waits or stopped                               |
| `usd`      | What its sessions cost                                     |

`asking` is a run that waits for an answer, `waiting` one at a human step. Both need a person; see
[The loop](loop.md#waiting). The file is rewritten whole each time, so a run can be picked up on
another machine.

## The trace

`trace.jsonl` is append-only. Every line has a time and a step, and one of these:

- `prompt`: what a session was opened with: harness, model, system prompt, prompt and tools.
- `event`: something the session did, as the harness reported it: text, a tool call, usage, the end.
- `session`: how a session ended, whether it resumed one, and what it cost.
- `verdict`: one check's result, with its output when it failed.
- `applied`: a proposal and whether it was applied, with its URL or the reason it was not.
- `outcome`: how a try ended (pass, refused, back, ask, answer or stop) and where the run went next.

The studio and `status` read these files and nothing else.

## Checkout

Each run works in a checkout of the mirror, on the branch the workflow names. When a run's scope
closes, its files are kept under `refs/bothub/runs/<run id>` in the mirror, so a run that waits for
a human picks up where it left off. The mirror's refs are read-only inside the sandbox.

## Stopping early

A run stops with a reason when a session runs past its minutes, stalls, hits a provider fault or
the sandbox fails. The engine posts the reason on the issue, and the trace holds the details.
Closing the issue stops a waiting run.
