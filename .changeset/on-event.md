---
'@jannik-stacks/agi': patch
---

A workflow's `on:` map can say what a trusted `comment`, `approved`, `changes_requested` or `merged` event does to a live run (`answer`, `back`, `pass`, `stop`, `none`), so `comment: answer` wakes a run without `/agent`. Plugins can decide the same in code with `on.event`. Hooks now run in the order of the `plugins` keys in `settings.yaml`.
