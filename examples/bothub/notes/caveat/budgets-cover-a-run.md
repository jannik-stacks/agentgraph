---
title: A bot's daily budget covers the most one implement job can use
status: accepted
human: dogfood round 2 kink K17
---
A check bot runs once per item, on every attempt: review-src alone may judge 30 hunks four times.
When a bot's `runs-per-day` runs out, its items are skipped, the check could not run, and the job
stops to ask a human with all of its findings held back. Each bot's budget is at least the items
of every check it judges in one implement job times the four attempts; a test in
`tests/examples.test.ts` holds the hub to that. Raise the budget with the check's `max`, not after
a blocked run.
