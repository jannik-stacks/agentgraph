---
title: Policy at the edge
status: accepted
check: principle-named
human: pstack principle 4a
---
A rule about one hub's workflow goes in a skill or a check, never in `src/` or a prompt every agent sees.
Bad: triage close policy written into the engine prompt.
Good: the same rule in `skills/triage.md`.
