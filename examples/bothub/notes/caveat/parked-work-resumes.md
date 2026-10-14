---
title: A blocked job parks its work and the next run resumes it
status: accepted
human: dogfood round 2 kinks K12 and K19, reused jobs from dogfood round 5 K24
---
Every run of the implementor, however it ends, has its worktree committed whole and pushed to a
branch of its own, `bothub/<issue>-parked-<run id>`, beside the merge request branch. When it asked a
question, stopped or its checks still fail after the last attempt, the next run of the job on that
issue starts from the latest of these: the prompt opens a
`## Resuming` section with the question asked, or why it stopped and what its last failing checks
found, and the human's answer. The checks measure the change from where the branch forked, so the
parked work counts as part of the change.

A resumed run continues the parked work instead of redoing it. Its `push` lists the files it
changed on top of the parked work; the files already parked need not be listed again. The jobs it
needs that closed done before it blocked are reused, so an answer to the implementor does not
rerun triage. Answer a question with a `/bothub <answer>` comment on the issue, or as a comment on
the `unsure` issue followed by `/bothub`.
