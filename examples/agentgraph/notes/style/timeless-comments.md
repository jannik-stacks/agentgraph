---
title: Code comments are minimal and timeless
status: accepted
source: CLAUDE.md
check: rules
human: user rule in CLAUDE.md
---
A comment reads as if the code was always this way: no dates, decision numbers, names, renames or
history. TSDoc goes only on the published surface, as a short statement of what it does; any other
comment is `// UNEXPECTED: <what and why>`. Rationale lives in docs and decision records, not in `.ts`
files.

Bad:

```ts
// formerly runner, renamed after decision 0012; asked for two retries
const harness = pick(bot);
```

Good:

```ts
const harness = pick(bot);

// UNEXPECTED: the harness counts its first try as attempt 0
if (attempt === 3) fail(run);
```
