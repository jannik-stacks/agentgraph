---
type: script
description: The triage reply follows the brief template, with at most five criteria that each name a test title and file.
run: node "$BOTHUB_HUB/scripts/triage-brief.mjs" --within src/,tests/,studio/src/,studio/seed.ts,studio/content/docs/
mode: block
human: six-angle dogfood review, narrow-bots W3, brief bounds dogfood round 2 kink K7
---
The sections are `## Task`, `## Criteria`, `## Files` and `## Out of scope`, in that order. Each
criterion is one numbered line that ends in `Test: it('<title>') in tests/<file>.test.ts`. The
script reads the reply from `BOTHUB_REPLY` and passes with a note when it is not set, so it gates
only once the hub hands the reply to checks.

Every file the brief names must sit under a root the implement job's safety check allows; a brief
that plans a change the safety check would block goes back to the triager before anyone builds it.
It blocks, so the triager gets one more round to narrow the brief or ask.
