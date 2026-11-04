---
'@jannik-stacks/agi': patch
---

`agi` parses its flags per verb: a flag the verb does not take is an error (exit 2), and `agi <verb> --help` shows that verb's flags. A verb's own flags go after the verb, so `agi --workflow w start text` is now an error; flags every verb takes, such as `--data` and `--tracker`, still go on either side. A flag given twice keeps its last value, except `--label` and `--run-label`, which add up. `-v` prints the version, like `--version`.
