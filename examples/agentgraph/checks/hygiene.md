---
mode: block
run: node "$AGENTGRAPH_HUB/scripts/hygiene.mjs"
---
Everything the bot publishes stays safe for a public repo: the pull request, comments, issues, commit messages and the lines the change adds name no home folder, no email address other than a noreply one, and nothing on the operator's deny list. The deny list is a file of case-insensitive patterns, one per line, at `AGENTGRAPH_DENY` or `deny.txt` in the hub; it stays out of git. Findings name the line of the list, never the word. Calibrated by a replay over every tracked file of this repo when it was added, with no findings.
