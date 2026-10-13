---
type: script
description: Added docs prose has no dates, names, internal references or filler words, and shows code as short excerpts.
run: node "$BOTHUB_HUB/scripts/docs-prose.mjs"
paths: [studio/content/docs/**]
mode: block
---
A `<Source>` of a `.ts` file names the `symbol` it is about, and a code block longer than 30 lines
becomes an excerpt. Research notes and decision numbers are linked pages, not inline references.
