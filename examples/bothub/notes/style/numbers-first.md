---
title: Numbers first, glyphs muted after them
status: accepted
source: dashboard review
check: code-shape
human: user dashboard feedback, feedback rule 11
---
A token count reads number first, then a small muted arrow for in or out. A cost shows the rounded
amount with no tilde or other mark; the exact billed and list-price values go in its tooltip. Use
`Io` and `Cost` from `dashboard/bits.tsx` rather than arranging icons and numbers again.
