---
'@jannik-stacks/agi': patch
---

A restart after a closed, unmerged pull request starts on a fresh `-2` branch from the base, keeps the old branch and pull request, shows the closed attempt to the first session and says `Replaces #n` in the new pull request. Every run with an open pull request, done or waiting at any step, now follows its base, and setup runs before conflict markers land. Thread replies go to the run's pull request under the thread's first comment, and an agent reports a sandbox or tool problem with `{"kind":"ask","runner":"..."}`, which the engine retries and parks instead of asking people.
