---
type: script
description: A name, field or literal the change renames or removes is gone from the rest of the code, hubs, skills, notes, docs and infra too.
run: node "$BOTHUB_HUB/scripts/propagation.mjs"
mode: warn
human: backlog item 3 of the takeover draft; over the last 120 commits it flagged 9, with about 17 of 20 findings real leftovers (deleted checks still named in skills and workflows, retired fields in the studio) and the rest same-named locals in unrelated files, so it warns instead of gating
---
A name the change takes out of every file it touches, by swapping it for another, deleting the line
that declares it or deleting its file, is looked up everywhere else. Each place that still says it
is a leftover copy: update it with the change, or say why it stays.
