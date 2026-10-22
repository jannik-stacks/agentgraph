# Sub-issues and stacks

An agent that returns `issue` can split the run's issue into sub-issues, and file follow-ups it found along the way. Every `issue` proposal says which with its `relation`: `part`, `follow-up` or `hub`. Parts can say what to build on and what to wait for. The [triage example](triage.md) uses all of this.

## Filing sub-issues

The agent proposes the parts as `issue` proposals with `"relation": "part"`, in the order they should land. Each has a short title, a body ending with a `## Done when` section of one to three observable checks, a `size` (`XS` to `XL`) and a `priority` (`high`, `medium` or `low`).

The engine files each part as a sub-issue of the run's issue and labels it `size/<size>` and `priority/<priority>`. <!-- code: src/engine.ts#file -->

`stacks_on` is the position of one earlier part whose code this part builds on, counting from 1 in the agent's list. `depends_on` lists positions of earlier parts that must be merged first. The engine turns them into lines at the end of the part's body, using the issue numbers it got: `Stacks on #n` and `Depends on #n`. To wait for an issue that already exists, the agent ends a body with `Depends on #<number>` itself.

The run's issue gets one comment: `Split into:` followed by a task list of the parts (`- [ ] #n`). Its body is never edited.

Every `XL` part still below the depth cap gets a run of the same workflow, begun by the engine. It carries the trust of the run that filed it and needs no trigger.

## Follow-ups

A follow-up is something the agent noticed that the run's issue does not ask for. It has only a `title` and a `body`, which ends with a `## Done when` section like a part's.

```json
{"kind": "issue", "relation": "follow-up", "title": "Reject a negative count in sum", "body": "...\n\n## Done when\n..."}
```

The engine files it as a plain issue: labelled `follow-up`, with no parent and no milestone, and a last line `Found while working on #n`. It starts no run. A maintainer reads it, and adds a trigger label when it should be worked on. Like every proposal, follow-ups land only when the try passes its checks, so a try that fails and retries files nothing twice. A try that ends in `ask` files none of them.

## Hub changes

A hub change is a follow-up about the bot itself: a workflow, agent or check that should have caught a miss. Its body names the class of miss and the check or lint that would catch it next time, and ends with `## Done when`.

```json
{"kind": "issue", "relation": "hub", "title": "Check that new exported fields are documented", "body": "...\n\n## Done when\n..."}
```

The engine files it like a follow-up, labelled `hub`. It starts no run. With the hub in the repo, working on it is a normal pull request that edits `.agentgraph/`, and the new rules count once a human merges it, see [A hub in the repo](loop.md#a-hub-in-the-repo).

GitHub writes for issues use their own token scope with only `issues: write`: the `issue` scope. <!-- code: src/github.ts#scopes -->

## Refusals

When one issue is refused, none is filed, and the try fails with the reasons as feedback. A part or a follow-up is refused when:

- an open issue already has its title,
- its body has no `Done when` heading,
- for a part, `stacks_on` or `depends_on` names a position that is not an earlier one in the same list,
- the run's issue text is withheld because its author is an outsider,
- for a part, the run's issue already sits 3 issues deep, the cap `deepest`, so it must be split by hand. <!-- code: src/engine.ts#deepest -->

## Stacks on and Depends on

A line `Stacks on #n` in an issue body says to build on the pull request of #n. It only does so when `stacks: true` is set in `hub.yaml`. When #n has an open pull request, or one on the branch its workflow works on, the run checks out that branch. Its own pull request goes into that branch, with `Stacks on #<pull>` in the body. <!-- code: src/engine.ts#stackOf -->

On GitHub, the engine also registers pull requests whose bases chain down as a GitHub stack, or adds the new one on top of its parent's stack. A repo without stacks keeps the plain chain, and a failure there is only logged. <!-- code: src/github.ts#githubForge -->

A run is held until its lines are met: <!-- code: src/engine.ts#pending -->

- `Depends on #n` holds it until #n is closed.
- `Stacks on #n` holds it until #n has a pull request.

A held run stays `running` and is picked up on a later tick. The engine neither drives it nor comments.

When the pull request it stacks on moves to a new head, and the run's own pull request is open, the engine rebases the run's branch onto the new head. On a conflict it comments on the issue that the branch could not follow, and asks for a manual rebase or instructions. <!-- code: src/engine.ts#follow -->

Workflows without a `branch` ignore both lines.
