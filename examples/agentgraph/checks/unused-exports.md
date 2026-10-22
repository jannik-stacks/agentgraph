---
mode: block
run: node "$AGENTGRAPH_HUB/scripts/unused-exports.mjs"
---
Everything the change adds is wired in, every new export used by another file, every new file imported outside tests, every new optional field set and every new event type read outside tests.

Code nobody calls is code nobody needs yet. Wire it into the code that needs it, or drop it.
