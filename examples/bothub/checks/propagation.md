---
mode: warn
run: node "$BOTHUB_HUB/scripts/propagation.mjs"
---
A name, field or literal the change renames or removes is gone from the rest of the code, hubs, skills, notes, docs and infra too.

A name the change takes out of every file it touches, by swapping it for another, deleting the line
that declares it or deleting its file, is looked up everywhere else. Each place that still says it
is a leftover copy: update it with the change, or say why it stays.
