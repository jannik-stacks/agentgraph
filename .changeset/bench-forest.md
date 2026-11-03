---
'@jannik-stacks/agi': patch
---

Show bench points as rows grouped by case set, with label columns, each case's mean over its repeats behind the point's mean, median and middle half, hidden tests as a share, cost as mean ± spread and time in s, min or h, and link every run to its trace with `/runs/<id>?data=<arm data dir>`. Points never merge across case sets, intervals show from 10 cases on, the frontier shows for one case set, axes use real minus signs and cost labels no longer overlap. Points are named by the labels picked under names, and labels that would overlap are moved with a leader line or hidden.
