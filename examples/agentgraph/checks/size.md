---
mode: block
run: node "$AGENTGRAPH_DIR/scripts/size.mjs"
---
The change adds at most the lines and changes at most the files outside tests/ that scripts/bounds.mjs allows. Only files that add or change lines count toward the file cap, so a file that only deletes lines does not, and neither does a file that only makes the change's one rename.
