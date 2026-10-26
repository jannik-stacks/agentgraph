---
title: Numbers first, glyphs muted after them
status: accepted
source: dashboard review
check: code-shape
human: user dashboard feedback
---
A token count reads number first, then a small muted arrow for in or out. A cost shows the rounded
amount with no tilde or other mark; the exact billed and list-price values go in its tooltip. Use
`Io` and `Cost` from `dashboard/bits.tsx` rather than arranging icons and numbers again.

Bad:

```tsx
<span><ArrowDown /> {tally.in} <ArrowUp /> {tally.out}</span>
<span>~${cost}</span>
```

Good:

```tsx
<Io tally={tally} />
<Cost billed={billed} estimated={estimated} tally={tally} />
```
