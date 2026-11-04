---
mode: block
run: node "$AGENTGRAPH_DIR/scripts/lint.mjs"
---
Changed code passes oxlint with the repository config on the lines it adds, and changed files are formatted with oxfmt and the repository config.

For an unchanged test split, existing moved lines keep their existing lint status. New lines still pass the checks.
