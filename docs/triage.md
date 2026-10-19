# Triage

An example workflow from the sandbox hub, `examples/sandbox`. It is hub config, not part of the engine: a team can copy it, change it or leave it out. It shows a workflow built only from the engine's general parts, a label trigger, one agent step, a script check and the `issue` proposal.

| File                  | What it does                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `workflows/triage.md` | Starts on the `triage` label or from the router, one step `triage` with the check `sized` |
| `agents/triager.md`   | Read-only tools (`read`, `grep`, `glob`), returns `label`, `issue` and `ask`              |
| `checks/sized.md`     | A `block` script check: the reply ends in a size label, a split or an `ask`               |

```
 issue #1 gets the triage label
   │
   v
 the triager reads the issue and the code
   │
   ├──> unclear: one ask with numbered questions, the run waits
   │
   ├──> XS to L: one size label, the run is done
   │
   └──> XL: a size label and a split into sub-issues
          │
          ├──> #2                    pull request into main
          ├──> #3 Stacks on #2       pull request onto #2's branch
          └──> #4 Depends on #3      held until #3 is closed
```

## Sizes

The triager proposes exactly one `size/<size>` label on the issue. Its agent file defines the sizes:

- `XS` is a line or two.
- `S` is a few lines in one or two places.
- `M` is one function and its test.
- `L` is one pull request a reviewer reads in one sitting.
- `XL` is more than that.

An issue of size L or smaller only gets its size label. An XL issue is also split into parts, each small enough to land as one pull request. The engine files them as sub-issues, and every XL part is triaged again, see [Sub-issues and stacks](stacks.md). The `sized` check fails a split with a part as big as the issue.

## Questions

When the issue and the repo do not say what the problem is or what done looks like, the triager asks instead of guessing. It asks only what it cannot find by reading, in one `ask` of at most six numbered questions: the problem, who hits it, what done looks like, scope, constraints, and an example. If only one thing is missing, it asks that one question. The answer is a comment on the issue, and the run goes on from there.

## Outcomes

- `running`: the triager is sizing or splitting.
- `waiting`: it asked a question, or its tries ran out.
- `done`: the issue is sized, or split and listed.
- `stopped`: someone said stop, the issue closed, the `triage` label was removed, or a limit ended it.

Nothing is implemented, merged or closed.
