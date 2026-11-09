# Dashboard experiment

This clone-only example adds a live studio dashboard through a graph plugin.
It adds no engine service, storage or npm dependency.

Copy `plugins/dashboard.ts` and `plugins/dashboard/` into your graph's `plugins/` folder.
Keep the example's relative engine imports when using this graph in this checkout.
If you move it elsewhere, point its host imports at this checkout's `src/plugin.ts`
and `src/store.ts`. The store has no published plugin entry yet.
Copy the `plugins.dashboard` block from settings.yaml into your graph's settings.yaml.
Set `data` to the absolute path of the run data folder you want to read.
This path stays on the host. Choose the same folder the studio serves.

Run `npm run dev -- --dir ../examples/dashboard --data /path/to/instance/data`
from `studio/`, or start your own graph with the same studio command.
Open `/plugins/dashboard`, or choose Dashboard in the header.
For named instances the page is `/<instance>/plugins/dashboard`.
Restart after changing plugin code. Settings changes reload through the studio.

Each widget needs `title`, `type`, `source` and `days`.
Types are `counter`, `line`, `bar` and `table`.
Sources are `runs`, `checks`, `tokens` and `cost`.
Optional `workflow` and `step` select one workflow or step.
There can be at most 24 widgets, each covering 1 to 90 UTC days, including today.
Unknown keys and source names fail validation.

Runs show their current state, grouped by start day. They do not reconstruct past states.
A run's step filter selects its current step.
Checks count all pass and fail attempts by check day, including repeated checks.
Tokens sum input and output usage events by event day. Input includes cached tokens.
Cost sums reported USD from usage events. Missing prices count as visible skips.
Cost excludes command checks and other charges without usage events.
Usage and check step filters select the recorded event's step.
Checks and usage from runs started before the window still count.
Each chart has a daily values table. Empty days show zero.

The existing studio connection refreshes the snapshot when the data folder changes.
The reader needs no tracker credentials and makes no external network calls.
No polling or new history file is needed.
Time windows advance on the next data refresh.
The reader scans the store on each refresh. Keep this experiment to modest stores.
It reads runs, all check attempts when needed, and traces only for usage widgets.
Tracker issue history is not available through this reader; no history is invented.
