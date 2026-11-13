---
'@jannik-stacks/agi': patch
---

A resumed codex session no longer counts its earlier spend again. Codex reports the whole session's usage on every resume, so the run spend, the `usd-per-run` limit, studio and bench added it up once per resume; each session line now holds only what that resume spent. Traces written before this keep their inflated session costs.
