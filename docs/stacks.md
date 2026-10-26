# Sub-issues and stacks

An `issue` proposal's `relation` is `part`, `follow-up` or `hub`. Parts split the current issue, follow-ups file other work, and hub changes file work on the hub. The [triage example](triage.md) uses parts.

## Filing sub-issues

Propose parts in landing order. Each has a title, a body ending in `## Done when` (one to three observable checks), and a `size` from `XS` to `XL`. The engine files them as sub-issues labelled `size/<size>`. <!-- code: src/engine.ts#file -->

`stacks_on` names one earlier part by position, counting from 1, and `depends_on` lists earlier positions. The engine adds `Stacks on #n` and `Depends on #n` lines with the new issue numbers. For an issue that already exists, write the `Depends on #<number>` line in the body yourself.

The parent gets a `Split into:` comment with a task list, and its body stays as it was. Each `XL` part starts the same workflow without a trigger, down to the depth cap.

## Follow-ups

`relation: follow-up` files work outside the current issue: a title and a body ending in `## Done when`, without a size.

```json
{"kind": "issue", "relation": "follow-up", "title": "Reject negative counts", "body": "...\n\n## Done when\n..."}
```

The issue is labelled `follow-up`, has no parent or milestone, and ends with `Found while working on #n`. It starts no run until a maintainer adds a trigger label.

A follow-up or hub change whose title matches an open one becomes a comment there instead. Agents that may file issues see the open follow-up and hub titles. <!-- code: src/engine.ts#file src/engine.ts#filed -->

## Hub changes

`relation: hub` files a follow-up labelled `hub`. Its body names the recurring miss, the workflow, check, lint or prompt that would catch it, and `## Done when`.

Filing issues uses a token limited to `issues: write`. <!-- code: src/github.ts#scopes -->

## Refusals

One refused proposal files none of the issues and fails the try with feedback. The engine refuses:

- A body without the `Done when` heading.
- Any filing while the current issue's text is withheld because an outsider wrote it.
- A part whose title matches an open issue.
- A part reference to anything but an earlier position.
- Parts of an issue already three levels deep (`deepest`); split it by hand. <!-- code: src/engine.ts#deepest -->

## Stacks on and Depends on

With `stacks: true` in `hub.yaml`, `Stacks on #n` builds on the open pull request of #n, or on its workflow branch. The new pull request targets that branch and says `Stacks on #<pull>`. <!-- code: src/engine.ts#findStackBase -->

The engine also registers the chain as a GitHub stack where the repo supports it; elsewhere the branches simply chain. <!-- code: src/github.ts#githubForge -->

A workflow with a `branch` holds a run until every `Depends on #n` issue is closed and every `Stacks on #n` issue has a pull request. Both must be lines of their own. A held run stays `running` but is not driven. Workflows without a branch ignore both lines. <!-- code: src/engine.ts#pending -->

When a stacked parent's head moves, the open child branch rebases onto it. A conflict asks for a manual rebase or instructions. This is separate from a wait step's [`follow`](loop.md#when-the-base-or-the-hub-moves). <!-- code: src/engine.ts#follow -->
