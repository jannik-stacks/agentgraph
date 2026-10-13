---
title: A stored identity lives in a field, never in free text
status: accepted
human: dogfood x iteration 1, step ids read back from issue bodies failed on a hand edit (X6)
---
An id bothub has to find again, such as the step a sub-issue was filed for, goes in a structured
field of what it writes or in a sidecar file next to it, never in text a human or another bot can
edit and bothub parses back, like an issue body, a title or a comment. Free text gets edited,
quoted and reformatted; a marker parsed back from it matches the wrong thing or nothing.

Bad:

```ts
const step = /<!-- bothub-step: (\S+) -->/.exec(issue.body)?.[1];
```

Good:

```ts
const filed = await readSteps(parent);
const number = filed[step];
```
