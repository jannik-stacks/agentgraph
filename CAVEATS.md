# Caveats

- Plugin pages refresh on the instance's `data` topic. Tracker events alone do not refresh them, since the
  studio does not watch tracker folders. The dashboard's issue widget lags until a run changes.
- The instance host builds a tracker layer per read call. Fine for the folder tracker; a GitHub tracker pays
  token setup per call.
- The dashboard's issue widget counts `since` events, so a GitHub tracker reads every event in the window.
- The studio check now needs `@jannik-stacks/agi/plugins` aliases in the root tsconfig and vitest config,
  next to the existing studio tsconfig path. A published `.d.ts` for the studio entry is still missing.
- `/api/logs` now returns 404 for an instance whose `instance.yaml` fails to load, where it used to read the
  data folder anyway.
