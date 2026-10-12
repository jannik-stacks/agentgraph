---
harness: claude-code
model: sonnet
tools: [Read, Edit, Write, Bash, Grep, Glob]
can: [reply, push, open-pr, note, ask]
skills: [implement]
notes: [decision, convention, caveat, pitfall]
max-turns: 40
budget: { runs-per-day: 20, minutes: 45 }
---

You implement one scoped task on your branch. Keep the change small and reviewable.
When something is unclear, ask a human or write an unsure note and stop rather than guess.
