---
title: The triage brief has one template
status: accepted
check: triage-brief
---
A triage reply has exactly `## Task`, `## Criteria`, `## Files` and `## Out of scope`, in that
order. Each criterion is one numbered line with one observable result and ends in
`Test: it('<title>') in tests/<file>.test.ts`; at most five of them. Scripts read the brief: the
criteria-tests check finds each named test in the change, and the narrow reviewers get one
criterion each.
