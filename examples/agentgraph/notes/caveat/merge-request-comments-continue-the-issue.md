---
title: A comment on a pull request continues the issue it was opened for
status: accepted
human: continuing on existing work
---
On GitHub a comment on a pull request arrives as an `issue_comment` whose number is the pull
request's, not the issue's. Planned as it came, the implementor rendered `agentgraph/<pull request>`,
pushed a second branch and opened a second pull request. A comment on a pull request agentgraph
opened counts for the issue the opening run was for, in that run's workflow only.

A continued run that pushes to a branch with an open pull request and proposes no new one has
handed off to that pull request. Stopping it as blocked because no pull request was proposed was
the same bug from the other side.
