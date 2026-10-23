# Triage

`examples/sandbox` sizes and splits issues with hub config alone. Copy it and change it freely.

| File | Role |
| --- | --- |
| `workflows/triage.md` | Starts on the `triage` label or a dispatch; one step with the `sized` check |
| `agents/triager.md` | Read-only `read`, `grep`, `glob`; returns `label`, `issue`, `ask` |
| `checks/sized.md` | Blocking script: a size label or a split, with every part smaller than the issue |

## Sizes

The triager proposes exactly one `size/<size>` label:

| Size | Scope |
| --- | --- |
| `XS` | A line or two |
| `S` | A small edit |
| `M` | One function and its test |
| `L` | One pull request reviewable in one sitting |
| `XL` | Split into smaller parts |

Issues up to L get only a size label. XL issues are also split into [sub-issues](stacks.md#filing-sub-issues), and an XL part is triaged again.

## Questions

The triager reads the issue, code and docs first. What is still missing goes in one `ask` of at most six numbered questions: problem, affected users, how to tell it is done, scope, constraints and an example. A person [answers on the issue](loop.md#waiting).

## Outcomes

| Status | Meaning |
| --- | --- |
| `running` | Sizing or splitting |
| `waiting` | Question, exhausted tries or runner error |
| `done` | Sized or split |
| `stopped` | Explicit stop, closed issue, removed trigger label or spend limit |

Triage never implements, merges or closes anything.
