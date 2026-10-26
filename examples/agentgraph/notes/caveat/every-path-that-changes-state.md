---
title: An identity must survive every path that changes its state
status: accepted
check: criterion-met
human: dogfood round 2 run 2 review finding
---
A key or id derived from state is only as good as the paths that keep that state. A label's
delivery id built from its count of recorded additions looked right in every hunk, yet removing a
label records nothing, so a label removed and added again by hand while serve was stopped got the
old id and never ran. Before keying on a counter or a digest, list every path that changes what it
reads: add, remove, a hand edit of the files, a restart. Each one either updates it or is covered
by a test.
