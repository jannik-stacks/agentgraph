---
type: bot
description: Each assertion a test hunk adds checks a value the change produces.
bot: checker
over:
  each: node "$BOTHUB_HUB/scripts/hunks.mjs" tests/
  max: 30
paths: [tests/**]
mode: shadow
---
The item is one hunk of a test file. Does every assertion it adds compare against a value that
would be different if the code under test had not changed? FAIL naming an assertion that holds
either way, such as one that compares against `undefined` or against the input it was given;
otherwise PASS.
