---
type: bot
bot: reviewer
minutes: 20
skill: review-file
over: each-file
mode: warn
description: A second model judges every changed file.
human: seed example, untraced
---

Changes to tests count as findings only when they weaken an assertion.
