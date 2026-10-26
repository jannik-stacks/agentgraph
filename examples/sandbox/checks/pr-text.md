---
mode: block
run: node "$AGENTGRAPH_DIR/scripts/pr-text.mjs"
---
The commit messages and pull request body follow the implementor prompt: conventional one-line subjects, no test counts, no steps not run, no boilerplate. Pull request bodies stay under 120 words with no test counts, "this PR" or process filler; calibrated by the replay of kit PRs #16 to #23, whose bodies ran to 200 words with test counts and closing boilerplate.
