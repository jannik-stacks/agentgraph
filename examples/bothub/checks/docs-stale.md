---
type: bot
description: A docs paragraph that names an export the change touches still describes the code as it now behaves.
bot: reviewer
minutes: 15
over:
  each: node "$BOTHUB_HUB/scripts/docs-mentions.mjs" src/ studio/content/docs/
items: 10
paths: [src/**]
mode: warn
human: build-dir change in dogfood round 22 left sandbox.mdx saying runs of one hub share the cargo target directory; review-docs reads only docs hunks, and a change to code alone has none
---
The item is one docs paragraph and the exports it names that the change touches. Read those exports
in the changed code. Does every statement in the paragraph hold against the code as it is now? FAIL
naming the statement and the code that contradicts it; otherwise PASS. Wording and tone are other
checks' job.
