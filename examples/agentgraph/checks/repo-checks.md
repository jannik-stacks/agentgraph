---
mode: block
run: npm run -s check:docs && npm run -s check:hubs
---
The repo's own docs and hub checks pass, the ones `npm run check` runs for every human commit: docs refs and commands, schema fields, the style baseline, and every hub in the repo loads. Calibrated by a replay at the commit that added it, with no findings.
