---
type: script
description: Shipped code the change adds is finished and real, with no markers for later and no fakes.
run: node "$BOTHUB_HUB/scripts/unfinished.mjs"
paths: [src/**, studio/src/**, bin/**]
mode: block
human: mined from user feedback, feedback rule 5
---
No TODO, FIXME or "not implemented", and no fake, stub, mock or dummy in `src/`, `studio/src/` or
`bin/`. The simulator and the tests are where those belong.
