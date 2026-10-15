# Hub config

The files a hub is made of and the config they compile into.

Every hub file is Markdown with YAML frontmatter, validated by one zod schema per kind in
`schema.ts`. `compile` routes the files by directory, checks every cross reference and
rejects the whole hub on the first error. Skills, checks, notes and the hub file follow the same
shape; the two below carry most of the meaning.

## Bot

The fields are on `Bot` in [src/schema.ts](../../src/schema.ts).

## Returns

What a bot returns at most, and a step narrows: proposal kinds, or `hub(<globs>)` for hub files.
A glob that leaves the hub or reaches `hub.yaml`, `bots/` or `workflows/` is an error.

See `Return` in [src/schema.ts](../../src/schema.ts).

## Preload

See `Preload` in [src/schema.ts](../../src/schema.ts).

## Loads

What a bot's harness loads from the target repo itself: a kind, or `skills/<name>`, `tools/<name>` or
`mcp/<name>` for one item. Each harness supports some kinds; `bothub check` fails on the others.

See `LoadEntry` in [src/schema.ts](../../src/schema.ts).

## Check

A check has a `type`, and each type takes its own fields: `script` takes `run`, `bot` takes `bot`
and an optional `skill`, and `decide` takes an optional `threshold`. Scripts and bot checks take
`minutes`, which caps one run or session. All of them take `over`, `items`, `paths`, `mode` and
`description`. The body is the bot's prompt or the decide question. A field the type does not take
is an error, and a missing `type` names the one the fields suggest. A check that no step lists in
`checks` or `requires` never runs, and `bothub check` warns about it.

See `Check` in [src/schema.ts](../../src/schema.ts).

## Over

What a check or step looks at, and whether it runs once or once per item; see
[The loop](../loop.md#checks). `items` beside it caps how many items a fan-out takes.

See `Over` in [src/schema.ts](../../src/schema.ts).

## Step

A workflow is a set of triggers and its `steps`, which run in the order written. Each step is one
of three kinds. A `bot` step casts a bot with a skill, the step's name unless `skill` says
otherwise, and takes `checks` and `tries`: the checks judge every attempt, and `tries` is the number
of attempts in all, 3 by default. A `run` step runs a script. A `wait: human` step stops the walk
until a human answers, then goes `back` to the step before it or the one it names.

Bot and run steps take `over`, `items`, `branch`, `into`, `requires`, `returns`, `minutes` and
`paths`. Any step takes `next`, the step after it or `end`, when the written order is not enough.

`branch` and `into` are filled from the event: `{issue}`, `{slug}`, `{parent}` (the issue's parent
plan), `{base}` (the branch a pull request goes into), `{workflow}` and `{step}`. A step whose event
has no value for one of them is blocked. `branch` must start with `bothub/` and cannot sit inside
`into`. Merging is on [Proposals](../proposals.md#merging).

A hub written with the older job keys fails to load, and each error says what to write instead.

See `Step` in [src/schema.ts](../../src/schema.ts).

## Hub

`hub.yaml` says where issues live, who merges into the default branch and how the dependencies
a run needs are installed; see [Sandbox and models](../sandbox.md#dependencies).

See `Hub` in [src/schema.ts](../../src/schema.ts).

See `MergeSection` in [src/schema.ts](../../src/schema.ts).

## Limits

`limits` in `hub.yaml` caps how much runs. `minutes` caps one session or script unless its step or
check sets its own, 30 by default. `runs-per-day` counts each bot's runs, checks and attempts
included, and `usd-per-run` caps one step's attempts and their checks. `bots` sets the same per bot,
plus `sessions`, how many of its sessions run at once.

See `Limits` in [src/schema.ts](../../src/schema.ts).

## Human

Every hub file, local issues included, takes an optional `human` field: notes for humans, never
shown to a model and never changing the flow. It is plain text or a map of strings, such as where
the item came from. The studio shows it in the node details.

See `Human` in [src/schema.ts](../../src/schema.ts).

## Config

See `Config` in [src/config.ts](../../src/config.ts).
