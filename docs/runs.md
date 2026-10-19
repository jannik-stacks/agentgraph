# Runs

What a run records, and where.

A run is one workflow on one issue. Everything bothub keeps sits in one data directory, `BOTHUB_DATA`.

```
$BOTHUB_DATA/
  <run id>/run.json       where the run stands
  <run id>/trace.jsonl    one line per thing that happened
  mirror.git              a bare mirror of the repo
  work/<id>/              one checkout, removed when it closes
  index/<id>, news/<id>/  that checkout's git index and its news file
  homes/<id>/             a session's private home: the harness's own history
  logs/<sha256>.gz        the full output of a check, stored once per content
  .locks/                 one lock file per run being driven
```

A run id is the workflow name, the issue number and a timestamp, so runs sort in the order they began.

## run.json

| Field      | Meaning                                                         |
| ---------- | --------------------------------------------------------------- |
| `id`       | The run id                                                      |
| `workflow` | The workflow it runs                                            |
| `issue`    | The issue number                                                |
| `step`     | The step it is on                                               |
| `status`   | `running`, `waiting`, `done` or `stopped`                       |
| `tries`    | Tries used on this step                                         |
| `rounds`   | Times each step has gone back                                   |
| `sessions` | The session of each step, so a try resumes it                   |
| `feedback` | The feedback for the next try                                   |
| `reason`   | Why the run waits or stopped                                    |
| `comment`  | The id of its status comment on the issue                       |
| `said`     | Where a human last spoke: the issue or pull request, and thread |
| `base`     | The pull request it stacks on and the head it builds on         |
| `started`  | When it began                                                   |
| `usd`      | What its sessions cost                                          |

`waiting` means a person is needed: a review at a human step, or an answer to the question in `reason` anywhere else. See [The loop](loop.md#waiting). <!-- code: src/workflow.ts#Run -->

The file is rewritten whole each time, so a run can be picked up on another machine.

## The trace

`trace.jsonl` is append-only. Every line has a time and a step, and one of these kinds:

- `prompt`: what a session was opened with: harness, model, system prompt, prompt and tools.
- `event`: something the session did, as the harness reported it: text, a tool call, usage (with cache reads and writes where the harness reports them) or the end.
- `session`: how a session ended, whether it resumed one, and what it cost.
- `check`: one check's result, with its output cut short when it failed. A fan-out also writes one line per item. `log` names the full output in `logs/` by its hash and size.
- `applied`: a proposal and whether it was applied, with its URL or the reason it was not.
- `outcome`: how a try ended (pass, failed, back, ask, answer or stop) and where the run went next.
- `saved`: the fields of `run.json` that a write changed, and `cleared` for fields it removed.

The studio reads only these files. `status` reads them too, and asks GitHub which repos the App reaches. Writes go through the file store. <!-- code: src/store.ts#fileStore -->

## Check logs

Every script check and every judged check's final reply is kept whole in `logs/`, gzipped and named by its sha256. Output that repeats, such as a passing lint over many runs and tries, is stored once, which is why the folder is shared and not per run. The trace and the forge only see the short findings; the studio opens the full output from a check row. `BOTHUB_CHECK_LOGS` set to `failed` keeps only failing output, and `off` keeps none. It is a runner setting, not a hub one, since what a machine keeps on disk is the runner's choice. <!-- code: src/store.ts#checkLogs --> <!-- code: src/store.ts#Log -->

## Checkout

Each run works in a checkout of the mirror, on the branch the workflow names.

When a run's scope closes, its files are kept under `refs/bothub/runs/<run id>` in the mirror. A run that waits for a human picks up where it left off. <!-- code: src/docker.ts#docker -->

The mirror's refs are read-only inside the sandbox.

## Stopping early

A run stops with a reason when a session runs past its minutes, stalls, hits a provider fault, the sandbox fails, or the run's spend goes over the hub's `usd-per-run` limit.

The engine posts the reason in its status comment. The trace holds the details.

Closing the issue stops a waiting run.
