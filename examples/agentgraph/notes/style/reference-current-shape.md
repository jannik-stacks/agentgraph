---
title: Reference docs describe the current shape
status: accepted
check: review-docs
human: audit of the dogfood round 5 migration pull request
---
A reference page in `docs/` describes the fields as they are now. It never mentions
a removed or renamed field, not even to say what replaced it. An old field just fails as unknown,
and the hubs get updated in the same change.

Bad:

```md
`returns` replaces the old `can` field and lists what an agent may return.
```

Good:

```md
`returns` lists what an agent may return.
```
