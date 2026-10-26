---
title: Docs prose uses words, not symbols
status: accepted
source: CLAUDE.md
check: rules
human: user rule in CLAUDE.md
---
Write "contains", "then" and "to and from" instead of math or logic symbols, and commas, "and" or
an em dash instead of middle dots. A heading is a name: no em-dash tagline and no colon prefix or
suffix after it.

Bad:

```md
## Sending a call: the golden path

The client ∘ wallet pair signs and sends · one object per call.
```

Good:

```md
## Sending a call

The client composed with a wallet signs and sends, with one object per call.
```
