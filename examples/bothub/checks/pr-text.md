---
mode: warn
run: node "$BOTHUB_HUB/scripts/pr-text.mjs"
---
The commit messages and pull request body follow the implementor prompt: conventional one-line subjects, a body of at most three lines, no test counts, no steps not run, no boilerplate, one Stacks on line. The same script holds this repository's own commits through `bin/hooks/commit-msg`.
