---
title: A blocked job parks its work and the next run resumes it
status: accepted
human: dogfood round 2 kinks K12 and K19, reused jobs from dogfood round 5 K24
---
When the implementor asks a question and closes as blocked, or its checks still fail after the
last attempt, bothub commits the worktree and pushes it to `bothub/<issue>` without a merge
request. The next run of the job on that issue starts from that branch: the prompt opens a
`## Resuming` section with the question asked and the human's answer, and the checks measure the
change from where the branch forked, so the parked work counts as part of the change.

A resumed run continues the parked work instead of redoing it. Its `push` lists the files it
changed on top of the branch; the files already parked need not be listed again. The jobs it
needs that closed done before it blocked are reused, so an answer to the implementor does not
rerun triage. Answer a question with a `/bothub <answer>` comment on the issue, or as a comment on
the `unsure` issue followed by `/bothub`.
