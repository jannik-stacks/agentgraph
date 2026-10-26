---
mode: warn
each: node "$AGENTGRAPH_DIR/scripts/docs-mentions.mjs" src/ docs/
agent: reviewer
max: 10
---
A docs paragraph that names an export the change touches still describes the code as it now behaves.

The item is one docs paragraph and the exports it names that the change touches. Read those exports
in the changed code. Does every statement in the paragraph hold against the code as it is now? Fail
naming the statement and the code that contradicts it; otherwise pass. Wording and tone are other
checks' job.
