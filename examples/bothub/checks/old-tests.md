---
type: script
description: The base's version of every test file the change edits still passes against the change's code, criterion tests of the brief aside.
run: node "$BOTHUB_HUB/scripts/old-tests.mjs"
paths: [tests/**]
mode: warn
human: dogfood round 11 (backlog item 49), where bothub rewrote old tests to fit a behaviour change and Haiku did the same; a replay of T11-41 names the 12 old tests that change edited to pass, 11 in tests/pipeline.test.ts and 1 in tests/merge.test.ts, in about 40 seconds; an issue that changes a behaviour on purpose fails its old tests too, so it warns until replays show how often that happens
---
An old test that fails against the change was edited to pass. Either the issue changes that behaviour on
purpose, and the reply says so by the test's title, or the edit hides a regression and the code goes back.
