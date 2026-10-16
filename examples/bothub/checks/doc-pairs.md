---
mode: warn
each: node bin/refs.mjs --diff "$BOTHUB_BASE"
agent: checker
max: 20
---
A docs section and the code symbol it cites still say the same thing after the change.

The item names one docs section (`docs/<page>.md#<heading>`), one symbol it cites (`src/<file>.ts#<name>`)
and which side the change touched. Read that section and that symbol as they are now. Does every
statement the section makes about the symbol hold for the code? FAIL with the statement, the line
of code that contradicts it and the smallest fix to whichever side is wrong; otherwise PASS.
