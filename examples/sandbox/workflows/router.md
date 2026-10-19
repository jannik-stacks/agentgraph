---
on: { issue_comment: { command: /bothub } }
agent: router
concurrency: queue
---
A maintainer mentions the bot on an issue. The router reads the message and decides: start triage on
the issue, file a new issue for something else the message asks for, or just reply. When the triage
it started settles, the router hears how and tells the maintainer what comes next.
