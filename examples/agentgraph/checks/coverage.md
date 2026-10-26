---
mode: block
run: node "$AGENTGRAPH_DIR/scripts/coverage.mjs" src/
---
The tests related to the change pass, and every line the change adds to src/ runs in one of them.
