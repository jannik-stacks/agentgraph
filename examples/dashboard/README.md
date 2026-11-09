# Dashboard experiment

This clone-only example adds configurable studio widgets through a plugin. It reads instance hosts and uses the studio's shared UI and live connection.

Copy `plugins/dashboard.ts`, `plugins/dashboard/` and the `plugins.dashboard` settings into your graph. From `studio/`, preview it with:

```sh
npm run dev -- --instance <name> --dir ../examples/dashboard
```

The page lives at `/<instance>/plugins/dashboard`. For a standalone run store, use `--dir ../examples/dashboard --data /path/to/data`; issues widgets need an instance tracker.

To read several served instances on one page:

```sh
npm run dev -- --instance a --instance b --plugins ../examples/dashboard
```

That page lives at `/plugins/dashboard`. Restart after code changes; settings reload through the studio.

Each widget requires `title`, `type`, `source` and `days`:

| Setting | Values |
| --- | --- |
| `type` | `counter`, `line`, `bar`, `table` |
| `source` | `runs`, `checks`, `tokens`, `cost`, `issues` |
| `days` | 1 to 90 UTC days, including today |
| `workflow`, `step` | Optional filters, except for issues |

At most 24 widgets are allowed; unknown settings fail validation. Runs show current states by start day; checks count all attempts by check day. Tokens include cached input; cost includes reported usage only. Missing prices or trackers show counted skips with reasons.

Run-data changes refresh the page; tracker events alone do not. Tracker reads cache for a minute. The reader scans the store on refresh, so use modest stores.
