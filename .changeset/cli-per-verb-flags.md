---
'@jannik-stacks/agi': patch
---

`agi` parses its flags per verb: a flag the verb does not take is an error (exit 2), and `agi <verb> --help` shows that verb's flags.
