---
"@jannik-stacks/agi": patch
---

Restart the studio server when engine code under `src` or `bin` changes, from both `agi studio` and the studio's `npm run dev`, so it never serves stale engine modules after an edit. A studio that fails to start still exits, with its status.
