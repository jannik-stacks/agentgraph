---
title: A waiting run keeps its work and the answer resumes it
status: accepted
human: dogfood round 2 kinks K12 and K19, reused jobs from dogfood round 5 K24
---
The checkout files of a run are kept under `refs/agentgraph/runs/<run id>`, however a try ends. When
the run waits on a question, a human step or an exhausted try, the next try of that run puts the
files back and continues from them, so the change from where the branch forked still counts as the
whole change.

A resumed try continues the kept work instead of redoing it. Its `push` lists the files it changed
on top of the kept work; files already kept need not be listed again. Steps that finished before
the run waited are not run again, so an answer to the implementor does not rerun triage. A human
answers by saying `/agent` on the issue.
