---
'@jannik-stacks/agi': patch
---

A tracker folder keeps each issue in its own folder, `<n>/issue.md` with `events.jsonl`, and the issue's status is the folder it sits in: `working/14/`, `needs-review/15/`. Folder trackers no longer add status labels. Move an existing instance's `tracker/` by hand: `<n>.md` to `<n>/issue.md`, `<n>.jsonl` to `<n>/events.jsonl`, `<n>.reactions` to `<n>/reactions`.
