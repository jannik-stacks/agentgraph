---
title: Untrusted input is parsed at the boundary
status: accepted
human: seed example, untraced
---

Webhook payloads, config files and tool arguments go through a schema where they enter. Code past
the boundary works with parsed types and never re-checks shapes.
