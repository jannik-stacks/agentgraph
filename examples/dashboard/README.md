# Dashboard experiment

This clone-only example adds a live studio dashboard through a graph plugin.
It adds no engine service, storage or npm dependency.
Its charts are plain SVG drawn with d3-scale, which the studio provides to page plugins.

Copy `plugins/dashboard.ts` and `plugins/dashboard/` into your graph's `plugins/` folder.
They use the public plugin entry and the `InstanceHost` type from `@jannik-stacks/agi/trackers`.
Copy the `plugins.dashboard` block from settings.yaml into your graph's settings.yaml.
The page reads runs and tracker events through the instance host. There is no `data` setting in `plugins.dashboard`.

Run `npm run dev -- --dir ../examples/dashboard --data /path/to/instance/data`
from `studio/` to read a run store. For the issues widget, use instance mode:
`npm run dev -- --instance <name> --dir ../examples/dashboard`.
The instance supplies the tracker.
Open `/plugins/dashboard`, or choose Dashboard in the header.
For named instances the page is `/<instance>/plugins/dashboard`.
Restart after changing plugin code. Settings changes reload through the studio.

Each widget needs `title`, `type`, `source` and `days`.
Types are `counter`, `line`, `bar` and `table`.
Sources are `runs`, `checks`, `tokens`, `cost` and `issues`.
Optional `workflow` and `step` select one workflow or step; `issues` takes neither.
There can be at most 24 widgets, each covering 1 to 90 UTC days, including today.
Unknown keys and source names fail validation.

Runs show their current state, grouped by start day. They do not reconstruct past states.
A run's step filter selects its current step.
Checks count all pass and fail attempts by check day, including repeated checks.
Tokens sum input and output usage events by event day. Input includes cached tokens.
Cost sums reported USD from usage events. Missing prices count as visible skips.
Cost excludes command checks and other charges without usage events.
Usage and check step filters select the recorded event's step.
Issues count tracker comments, closes and merges by event day. Instance mode supplies the tracker. Without one, the widget shows a skip and its reason.
Checks and usage from runs started before the window still count.
Each chart has a daily values table. Empty days show zero.

The existing studio connection refreshes the snapshot when the instance's run data changes.
Tracker events alone do not refresh it. Tracker reads are cached for one minute.
The reader uses the instance host's store and tracker.
No polling or new history file is needed.
Time windows advance on the next data refresh.
The reader scans the store on each refresh. Keep this experiment to modest stores.
It reads runs, all check attempts when needed, traces only for usage widgets,
and tracker events since the longest issues window.
