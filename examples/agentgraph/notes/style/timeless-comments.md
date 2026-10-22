---
title: Code comments are minimal and timeless
status: accepted
source: CLAUDE.md
check: rules
human: user rule in CLAUDE.md, feedback rule 4
---
A comment reads as if the code was always this way: no dates, decision numbers, names, renames or
history. TSDoc on an export is a short statement of what it does; inline comments only where the
code is genuinely unclear. Rationale lives in research notes and decision records, not in `.ts`
files.

Bad:

```ts
// formerly runner, renamed after decision 0012; asked for two retries
const harness = pick(bot);
```

Good:

```ts
const harness = pick(bot);

// the third failure is final
if (attempt === 3) fail(run);
```
