# Sub-issues and stacks

An `issue` proposal's `relation` selects `part`, `follow-up` or `hub`. Parts split the current issue; follow-ups file other work. See the [triage example](triage.md).

## Filing sub-issues

Propose parts in landing order with a title, body ending in `## Done when` (one to three observable checks), `size` (`XS` to `XL`) and `priority` (`high`, `medium`, `low`). The engine makes sub-issues labelled `size/<size>` and `priority/<priority>`. <!-- code: src/engine.ts#file -->

`stacks_on` names one earlier part's position, counting from 1; `depends_on` lists earlier positions. The engine appends `Stacks on #n` and `Depends on #n` using the resulting issue numbers. For existing dependencies, write `Depends on #<number>` directly in the body.

The parent receives a `Split into:` task-list comment; its body stays unchanged. Each `XL` part below the depth cap starts the same workflow automatically, inheriting trust without a trigger.

## Follow-ups

Use `relation: follow-up` for work outside the current issue. Supply title and body ending in `## Done when`, without size or priority.

```json
{"kind": "issue", "relation": "follow-up", "title": "Reject negative counts", "body": "...\n\n## Done when\n..."}
```

The issue has label `follow-up`, no parent or milestone, and ends with `Found while working on #n`. It starts no run; a maintainer adds a trigger label when ready. [Proposal application](proposals.md#applying) prevents filing from failed or asking tries.

A follow-up or hub change matching an open title becomes a comment there instead. Agents allowed to file issues see open follow-up and hub titles. <!-- code: src/engine.ts#file src/engine.ts#filed -->

## Hub changes

`relation: hub` files a follow-up labelled `hub`. Describe the recurring miss, the workflow, check, lint or prompt that would catch it, and `## Done when`. Like other hub edits, changes [take effect after merging](loop.md#a-hub-in-the-repo).

Issue creation uses the `issue` token scope, limited to `issues: write`. <!-- code: src/github.ts#scopes -->

## Refusals

One refused proposal files none of the issues and fails the try with feedback. Refusal reasons:

- Missing `Done when` heading.
- Current issue text withheld because its author is an outsider.
- Part title matching an open issue.
- Part references pointing outside earlier positions in the proposal list.
- Current issue already three parent levels deep (`deepest`); split by hand. <!-- code: src/engine.ts#deepest -->

## Stacks on and Depends on

With hub `stacks: true`, `Stacks on #n` builds on #n's open pull request or its workflow branch. The new pull request targets that branch and includes `Stacks on #<pull>`. <!-- code: src/engine.ts#stackOf -->

GitHub stack registration chains these pull requests, or extends the parent's stack. Unsupported repos keep plain branch chains; registration failure is logged only. <!-- code: src/github.ts#githubForge -->

A branched workflow is held until `Depends on #n` is closed and `Stacks on #n` has a pull request. Held runs remain `running`, without driving or comments, until a later tick. Workflows without `branch` ignore both lines. <!-- code: src/engine.ts#pending -->

When a stacked parent's head moves, an open child branch rebases onto it. Conflicts prompt for manual rebasing or instructions. This is separate from a wait step's [base-following policy](loop.md#when-the-base-or-the-hub-moves). <!-- code: src/engine.ts#follow -->
