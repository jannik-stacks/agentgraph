---
on: { issues: { label: triage }, dispatch }
steps:
  triage: { agent: triager, checks: [sized] }
---
A maintainer adds the `triage` label to an issue, or the router starts it. The triager reads the
issue and the code and sizes the issue from XS to XL. An issue of size L or smaller only gets its size label. An XL issue is split
into child issues, each small enough to land as one pull request. The runner files them, labels them
with their size, and triages every XL child again. Nothing is implemented, merged or
closed.
