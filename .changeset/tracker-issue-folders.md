---
'@jannik-stacks/agi': patch
---

A tracker folder keeps each issue in its own folder, `<n>/issue.md` with `events.jsonl`, and the issue's status is the folder it sits in: `working/14/`, `needs-review/15/`. Folder trackers no longer add status labels. A tracker still in the old flat layout is refused. Stop the loop and move it: `<n>.md` to `<n>/issue.md`, `<n>.jsonl` to `<n>/events.jsonl`, `<n>.reactions` to `<n>/reactions`, keeping `<n>/pull.json` and `diff.patch`, then move an issue with a status label into the folder of that status and drop the label.
