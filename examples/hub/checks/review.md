---
bot: reviewer
skill: review-file
for-each: file
mode: warn
description: A second model judges every changed file.
---

Changes to tests count as findings only when they weaken an assertion.
