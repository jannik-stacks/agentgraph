---
title: The triage brief has one template
status: accepted
check: triage-brief
human: narrow-bots W3 triage checks
---
A triage reply has exactly `## Task`, `## Criteria`, `## Files` and `## Out of scope`, in that
order. Each criterion is one numbered line with one observable result and ends in
`Test: it('<title>') in tests/<file>.test.ts`; at most five of them. Scripts read the brief: the
test-guards check finds each named test in the change, and the narrow reviewers get one
criterion each.

Bad:

```md
## Plan

Fix the retry timer, and tidy the queue while there.
```

Good:

```md
## Task

Make the retry timer wait again when it wakes early.

## Criteria

1. A timer that fires before its deadline arms a new wait. Test: it('waits again when woken early') in tests/serve.test.ts

## Files

- src/serve.ts

## Out of scope

- the queue file format
```
