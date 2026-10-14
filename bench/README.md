# bench

Measured experiments for tuning a hub. A hub setting runs over mined cases several times and every
run leaves one row of metrics, so two settings are compared on the same cases instead of on
anecdotes. The plan behind it is in `drafts/tuning.md`.

## Pieces

- `mine.mjs` mines cases from a repository's merged pull requests: `case.json` (repo, base sha,
  title), `issue.md`, `merged.diff`, `reviews.md` and `followups.json`, one directory per case.
- `compare.mjs` compares two diffs against a checkout: size, file and symbol overlap, scope creep,
  test and style statistics, and optionally test runs.
- `run.mjs` splits cases, runs settings over them and summarizes the rows.

## Splits

```sh
node bench/run.mjs split --cases CASES
```

Each case gets train, validation or test from a hash of its id and keeps it in
`CASES/splits.json`; later cases are added, stored ones never move. Tune on train and validation.
The driver refuses the test split unless `--report-only` says the run is only for reporting.

## A sweep

```sh
node bench/run.mjs run --hub HUB --cases CASES --clone CLONE --split validation --repeats 3 \
  --set warn-simpler='{"checks/simpler.md":{"mode":"warn"}}' \
  --set two-attempts=two-attempts.json \
  --env DATA/.env --out rows.jsonl
node bench/run.mjs summary rows.jsonl
```

`CLONE` is a local clone of the cases' repository that holds every base sha. Every case and repeat
runs the baseline (the hub as it is) and each `--set`, interleaved so drift in the model proxy hits
all settings alike. A set is a name and a patch over hub files, inline JSON or a file: an object
merges into a file's frontmatter (or into `hub.yaml`) with `null` removing a key, a string replaces
the file and `null` deletes it.

Each run works in a fresh temporary directory: a bare origin at the case's base sha, a copy of the
hub with the patch applied and a local tracker holding only the case's issue. It comments
`/bothub` (`--command`), serves the hub in process until nothing is left to run (or `--timeout`
minutes pass), then measures and deletes everything.

## Rows

| Field                                                      | Meaning                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `closure`                                                  | `merge-request`, or the closure of the first blocked or deferred job, else the last job's   |
| `attempts`, `maxAttempt`                                   | job runs in all, and the highest attempt number                                             |
| `questions`                                                | `ask` proposals accepted                                                                    |
| `falseHolds`                                               | holding check failures on an earlier attempt of a job whose final attempt passed that check |
| `usd`, `tokensIn`, `tokensOut`, `tokensCached`, `calls`    | usage from every run's events                                                               |
| `wallMs`, `busyMs`                                         | wall time, and the time at least one run was running                                        |
| `added`, `addedNoTests`, `files`                           | the merge request's diff                                                                    |
| `mergedAdded`, `mergedAddedNoTests`                        | the merged change's diff                                                                    |
| `fileJaccard`, `symbolJaccard`, `followupsCaught`          | overlap with the merged change                                                              |
| `ownTests`, `mergedTestsOnOurCode`, `ourTestsOnMergedCode` | with `--tests CMD`, the command run on each mix of code and tests                           |

`summary` gives, per setting, the median, min and max of every numeric field, and for each setting
other than the baseline (`--baseline`) the median per-case difference of medians against it, with
how many cases went up and down.
