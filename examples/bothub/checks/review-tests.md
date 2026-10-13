---
type: bot
description: Each assertion a test hunk adds checks a value the change produces.
bot: reviewer
over:
  each: node "$BOTHUB_HUB/scripts/hunks.mjs" tests/
  max: 10
paths: [tests/**]
mode: log
human: split of the broad review, narrow-bots W1, restated data from user feedback; qwen3.5 separates 3 of 6 calibration hunks and smart 5 of 6, so it logs until more hunks confirm it
---
The item is one hunk of a test file. Does every assertion it adds compare against a value that
would be different if the code under test had not changed? FAIL naming an assertion that holds
either way, such as one that compares against `undefined` or against the input it was given.
Also FAIL an assertion that only restates data files the change edits, such as re-reading an
example workflow and checking its keys, instead of checking what the code does with them;
otherwise PASS.
