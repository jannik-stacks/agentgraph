---
'@jannik-stacks/agi': patch
---

A run's labels log survives a last line a crash cut short: reads skip and count it, and the next edit moves it to a `.partial` file before it appends.
