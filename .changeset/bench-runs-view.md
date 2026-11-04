---
'@jannik-stacks/agi': patch
---

The bench is a view over runs. Each case, arm, repeat, point and graph has a slot in `<set>/runs/` with numbered attempts. The `human` and `base` references are imported runs, and scores and judges are `bench/*` results in a run's `checks.jsonl`. `bench/start-runs.ts` replaces `bench/drive.ts` and skips units already on disk. The `report`, `status` and `resume` commands, the `.cache` and `.attic` dirs, and the `BENCH_ENGINE`, `BENCH_DIR` and `BENCH_CACHE` variables are gone. `--max-codex` is now an absolute weekly percent (default 90).
