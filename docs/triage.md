# Triage

Triage is a workflow in the sandbox hub (`examples/sandbox/workflows/triage.md`, agent `triager`). A maintainer adds the `triage` label to an issue. The agent reads the issue and the code and sizes it from XS to XL.

When the issue and the repo do not say what the problem is or what done looks like, the triager asks instead of guessing. It asks only what it cannot find by reading, in one numbered comment of at most six questions (the problem, who hits it, what done looks like, scope, constraints, an example), and waits for `/bothub <answer>`. If only one thing is missing, it asks that one question.

Triage implements, merges and closes nothing. The triager has read-only tools (`read`, `grep`, `glob`) and may return `comment`, `label`, `issue` and `ask`.

```
 issue #1, label `triage`
        |
        v
 triager sizes it
   |            |
 XS to L       XL: split
 size label     |
 only           v
        children #2, #3, #4  (size/ and priority/ labels, sub-issues of #1)
        #2      #3 Stacks on #2      #4 Depends on #3
         |           |                  |
         v           v                  v
     PR on main   PR on #2's branch   waits until #3 is closed
                  (rebased when #2's PR moves)
```

## Sizes

The agent proposes exactly one `size/<size>` label on the issue.

- `XS` is a line or two.
- `S` is a few lines in one or two places.
- `M` is one function and its test.
- `L` is one pull request a reviewer reads in one sitting.
- `XL` is more than that.

An issue of size L or smaller only gets its size label. An XL issue is split into child issues, each small enough to land as one pull request.

## What a child issue gets

The agent proposes the parts as `issue` proposals, in the order they should land. Each has a short title, a body ending with a `## Done when` section of one to three observable checks, a `size` and a `priority` (`high`, `medium` or `low`).

The agent does not write size or priority into the body. The engine labels each child `size/<size>` and `priority/<priority>`. It files each child as a sub-issue of the run's issue (`code: src/engine.ts#file`).

`stacks_on` is the position of one earlier part whose code this part builds on, counting from 1 in the agent's list. `depends_on` lists positions of earlier parts that must be merged first. The engine turns them into lines at the end of the child's body, using the issue numbers it got: `Stacks on #n` and `Depends on #n`.

To wait for an issue that already exists, the agent ends a body with a line `Depends on #<number>`.

The run's issue gets one comment: `Split into:` followed by a task list of the children (`- [ ] #n`). Its body is never edited.

Every XL child still below the depth cap gets a run of the same workflow, begun by the engine. The parent's run was begun by a maintainer. The child's run carries that trust and needs no label event.

## When the engine refuses

When one child is refused, none is filed. The step retries with the reasons as feedback.

The engine refuses when:

- A child body has no `Done when` heading.
- `stacks_on` or `depends_on` names a position that is not an earlier one in the same list.
- The run's issue text is withheld because its author is not a collaborator. An outsider's text is never shown to the agent, so a run on it files nothing.
- The run's issue already sits 3 issues deep, the depth cap `deepest`. It must be split by hand (`code: src/engine.ts#deepest`).

GitHub writes for issues use their own token scope with only `issues: write`: the `issue` scope in `code: src/github.ts#scopes`.

## Stacks on and Depends on

An issue body line `Stacks on #n` says to build on the pull request of #n. When #n has an open pull request, or a pull request on the branch its workflow works on, the run checks out that branch. Its pull request opens with that branch as base and `Stacks on #<pull>` in the body (`code: src/engine.ts#stackOf`). This only happens when `stacks: true` is set in `hub.yaml`.

On GitHub, the engine also registers open pull requests whose bases chain down as a GitHub stack, or adds the new pull request on top of its parent's stack. A repo without stacks keeps the plain chain. A failure there is only logged (`code: src/github.ts#githubForge`).

`Depends on #n` waits until #n is closed. `Stacks on #n` waits until #n has a pull request (`code: src/engine.ts#pending`).

While a run waits, it stays `running` and is picked up on a later tick. The engine does not drive it or post a comment yet.

When the pull request it stacks on moves to a new head, and the run's own pull request is open, the engine rebases the run's branch onto the new head (`code: src/engine.ts#follow`). On a conflict, it comments on the issue that the branch could not follow and asks for a manual rebase or instructions.

Workflows without a `branch` ignore both lines.

## Order

Runs that can be driven sort by priority label first: `priority/high`, then no label or `priority/medium`, then `priority/low`. Within the same priority, the older run goes first (`code: src/engine.ts#tick`).

At most `limits.parallel` runs go at once. Nothing merges or closes without a human.

## What can happen

- `running`, driving: the triager is sizing or splitting.
- `running`, held: it waits on a `Stacks on` or `Depends on` line and is not driven.
- `waiting`: the agent asked a question, tries ran out, or a refusal repeated until tries ran out. A human answers with `/bothub <answer>`.
- `done`: sized, or split and listed.
- `stopped`: a human said `/bothub stop`, the issue closed, the `triage` label was removed, or a limit (minutes, usd-per-run) or a sandbox failure ended it.

A child's pull request can also be rebased by the engine when its parent moves, or get a comment when the rebase conflicts.
