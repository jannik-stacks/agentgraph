---
type: script
description: The triage brief names at most twice as many files outside tests/ as the issue's Done when has rows, and no more criteria than rows.
run: node "$BOTHUB_HUB/scripts/triage-brief.mjs" --width
mode: warn
human: dogfood round 11 (backlog item 48), a brief named 7 source files and a new plugin for 3 Done when rows; a row usually lands in the code that does it plus one caller or docs page, hence twice the rows. Over the 13 briefs with a Done when in rounds 9, 10, 11, t and x it flags 3, the round 11 one and two with 6 files for 3 rows, one of which added a criterion the issue did not ask for, so it warns until more rounds show it
---
A brief much wider than the issue gives the implementor room to build more than was asked. Name the
files the Done when rows need, and list the rest under `## Out of scope` as a follow-up. Keep one
criterion per Done when row.
