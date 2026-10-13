---
title: A comment on a merge request continues the issue it was opened for
status: accepted
human: continuing on existing work
---
On GitHub a comment on a pull request arrives as an `issue_comment` whose number is the pull
request's, not the issue's. Planned as it came, the implementor rendered `bothub/<pull request>`,
pushed a second branch and opened a second merge request. A comment on a merge request bothub
opened is planned as a comment on the issue the opening run was for, with the request as `pull`,
for that run's workflow only. Code that reads `event.number` reads the issue; code that needs the
request reads `event.pull`.

A continued run that pushes to a branch with an open merge request and proposes no new one has
handed off to that request. Closing it as blocked because no merge request was proposed was the
same bug from the other side.
