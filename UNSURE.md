# Unsure

- `resume` is not an action yet. Its function, `instruct` with a resume instruction, needs the engine's full
  services (`start` with a tracker setup and harness choice). Running that inside the studio process felt too
  heavy. `say <n> ":restart"` and `":stop"` cover the per-issue cases through the `commands` gate.
- `stop` and `restart` stay CLI-only: they signal or spawn a loop process that may serve several instances.
- Actions are offered to every page, graph-local or operator, because pages share the studio origin anyway.
  Readers get no actions. If graph-local pages should not act, the route would need the page's name, which
  any same-origin script can forge.
- A plain studio (`--dir --data --tracker <folder>`) reads that tracker but refuses `say`, since it has no
  owner to post as. Named instances post as the instance owner.
- `readStudioPages` hands the instance host to graph plugins whose graph may come from the repo. Reads there
  add no authority beyond what host code already has, but it is worth a second look.
- `/api/results` and the Results plugin still read the same sheet twice through `bin/results.ts`. Moving
  `readRunResults` onto the instance store would make one path; it reads sync files today.
- `InstanceHost` is exported from `@jannik-stacks/agi/trackers`, not `/plugins`. `src/plugin.ts` must stay a
  leaf for the import-cycle lint, and the host type pulls in the tracker and store. A reader types its own
  host parameter; `makePlugin` infers it, so nothing checks that the served host matches at compile time.
