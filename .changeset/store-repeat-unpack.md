---
'@jannik-stacks/agi': patch
---

Keep a run's full trace and check history when a long-lived store appends after the run was compressed again, and read a record that an append unpacks mid-read instead of reporting it empty.
