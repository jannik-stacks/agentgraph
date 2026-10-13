---
title: An error for a renamed field shows the user's value rewritten
status: accepted
check: review-src
human: audit of the dogfood round 5 migration merge request
---
When a hub file still uses a field that was renamed, the error quotes what the user wrote,
rewritten in the new shape, so the fix can be pasted back as it is. It never shows a fixed example
such as `[OWNER]` in place of their value. The rename is one finding among the rest: other unknown
keys in the same object are still reported, never hidden behind the rename message.
