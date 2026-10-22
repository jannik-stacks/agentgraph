# Triage

`examples/sandbox` sizes and splits issues through hub config. Copy or change it without engine changes.

| File | Role |
| --- | --- |
| `workflows/triage.md` | Starts on `triage` label or dispatch; one step with `sized` check |
| `agents/triager.md` | Read-only `read`, `grep`, `glob`; returns `label`, `issue`, `ask` |
| `checks/sized.md` | Blocking script requiring size label, split or question |

## Sizes

Propose exactly one `size/<size>` label:

| Size | Scope |
| --- | --- |
| `XS` | A line or two |
| `S` | A small edit |
| `M` | One function and its test |
| `L` | One pull request reviewable in one sitting |
| `XL` | Split into smaller parts |

L and smaller issues receive only a size label. XL issues also produce [sub-issues](stacks.md#filing-sub-issues); XL parts can be triaged again. The `sized` check rejects parts as large as the parent.

## Questions

Read the issue, code and docs first. Missing information goes in one `ask`, with at most six numbered questions covering problem, affected users, observable completion, scope, constraints and example. Ask only what's missing. A person [answers on the issue](loop.md#waiting).

## Outcomes

| Status | Meaning |
| --- | --- |
| `running` | Sizing or splitting |
| `waiting` | Question, exhausted tries or runner error |
| `done` | Sized or split and listed |
| `stopped` | Explicit stop, closed issue, removed trigger label or spend limit |

Triage implements, merges and closes nothing.
