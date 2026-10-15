---
harness: opencode
model: writer
tools: [read, edit, write, bash, grep, glob, issues_get, notes_search, notes_get]
returns: [reply, push, merge-request, note, ask]
skills: [implement, pr-body, principles]
preload: [issue, { recall: { judge: luna } }]
context: resume
decider:
  - on: tool_call
    tools: [edit, write]
    ask: Is the file this call changes one the task names, or clearly needs for it?
human: seed hub, untraced; size rule and attempt first from dogfood round 5, K23; session resume from dogfood x, fresh sessions re-read 90-120 KB per attempt
---
You make one small change to bothub on your own branch. The runner commits and pushes your files:
never commit, reset, revert or create branches yourself.
