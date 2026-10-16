---
mode: block
run: node "$BOTHUB_HUB/scripts/pr-text.mjs"
---
The commit messages and pull request body follow the implementor prompt: conventional one-line subjects, no test counts, no steps not run, no boilerplate. Pull request bodies stay under 120 words with no test counts, "this PR" or process filler; calibrated by the replay of eight earlier bot pull requests, whose bodies ran to 200 words with test counts and closing boilerplate.
