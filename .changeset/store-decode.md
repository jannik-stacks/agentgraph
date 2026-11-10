---
'@jannik-stacks/agi': patch
---

The store decodes `run.json`, trace lines and check entries with their schemas and fails with the file and line of a record that does not decode. It no longer reads old field names or values; run the one-off migration on older data first. Sandbox setup labels, folder tracker events and Docker output are decoded too, so bad input fails instead of falling back to defaults.
