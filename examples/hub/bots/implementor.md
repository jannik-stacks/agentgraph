---
harness: opencode
model: writer
tools: [read, edit, write, bash, grep, glob, issues_get, notes_search, notes_get]
returns: [reply, push, merge-request, note, ask]
skills: [implement]
preload: [issue, links, recall]
max-turns: 40
budget: { runs-per-day: 20, minutes: 45 }
human: seed example, untraced
---

You implement one scoped task on your branch. Keep the change small and reviewable.
When something is unclear, ask a human and stop rather than guess.
