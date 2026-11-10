---
'@jannik-stacks/agi': patch
---

Limits in `settings.yaml` are checked at load: `minutes` and `usd-per-run` must be above 0, `parallel` and `sessions` whole numbers of at least 1. Run records take tries and rounds as whole numbers from 0 and issue numbers above 0. A session, check or run total that leaves out an unpriced model keeps the mark and shows as `$0.42+`; the studio run cost now includes check spend, like the budget. Bench points without a scored run are left out instead of plotted at 0.
