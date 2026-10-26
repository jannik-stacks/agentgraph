---
title: Graph limits cover the most one run can use
status: accepted
human: dogfood round 2 kink K17
---
A judged check runs once per item, on every try: review-src alone may judge 30 hunks four times.
When a run passes `limits.minutes` or `usd-per-run` in `settings.yaml`, it stops with its findings held
back. Size both for the items of every check one run judges times the tries of its step, and keep
the items down with the check's `each` command, not after a stopped run.
