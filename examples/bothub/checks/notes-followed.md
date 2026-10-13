---
type: decide
description: Each hub note that covers a hunk of the change is followed by it, one note and one hunk per question.
over:
  each: node "$BOTHUB_HUB/scripts/note-pairs.mjs" src/ studio/src/ tests/ studio/content/docs/
  max: 40
threshold: 0.5
mode: log
human: backlog item 8 of the takeover draft, notes judged after the attempt instead of only surfaced before it; luna replayed over 16 dogfood and staged-miss changes caught all 6 labelled violations (X6 twice, X3, K25-era verdict parsing, continuation base, parked branch) but also flagged 30 of 151 clean pairs and errored on 34 of 206, so it logs
---
Is this hunk free of anything the hub note warns against? Yes when the note is about something
else, or when the hunk does what the note asks. No when the hunk does what the note warns against,
or the note says the change must reach a file missing from the files changed.
