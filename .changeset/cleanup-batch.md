---
'@jannik-stacks/agi': patch
---

A run the engine parks now says "Stopped by an engine error", and the CLI and docs call it an engine error; "runner" means only the command executor. A step's `each` takes a command as a plain string, as a check's does (`each: node script.mjs` instead of `each: { run: node script.mjs }`). Branches named `bothub/` are no longer agent branches. The studio names checks whose result comes from an older version.
