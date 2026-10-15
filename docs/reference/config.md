# Hub config

The files a hub is made of and the config they compile into.

Every hub file is Markdown with YAML frontmatter, validated by one zod schema per kind in
`schema.ts`. `compile` routes the files by directory, checks every cross reference and
rejects the whole hub on the first error. Skills, checks, notes and the hub file follow the same
shape; the two below carry most of the meaning.

## Bot

The fields are on `Bot` in [src/schema.ts](../../src/schema.ts).

## Returns

What a bot returns at most, and a job narrows: proposal kinds, or `hub(<globs>)` for hub files.
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
and optional `skill` and `max-turns`, which caps each item's run, and `decide` takes an optional `threshold`. All of them take `over`,
`paths`, `mode`, `concurrency` and `description`. The body is the bot's prompt or the decide question. A field
the type does not take is an error, and a missing `type` names the one the fields suggest. A
check that no job lists in `until` or `requires` never runs, and `bothub check` warns about it.

See `Check` in [src/schema.ts](../../src/schema.ts).

## Over

What a check or job looks at, and whether it runs once or once per item; see
[The loop](../loop.md#checks).

See `Over` in [src/schema.ts](../../src/schema.ts).

## Job

A workflow is a set of triggers and a map of jobs. A `bot` job casts a bot with a skill and takes
`until`, `preload` and `tools`; a `script` job takes `run`. Both take `on`, `needs`, `branch`,
`into`, `requires`, `returns`, `over`, `paths`, `mode`, `environment` and `timeout-minutes`.

`branch` and `into` are filled from the event: `{issue}`, `{slug}`, `{parent}` (the issue's parent
plan), `{base}` (the branch a pull request goes into), `{workflow}` and `{job}`. A job whose event
has no value for one of them is blocked. `branch` must start with `bothub/` and cannot sit inside
`into`. Merging is on [Proposals](../proposals.md#merging).

See `Job` in [src/schema.ts](../../src/schema.ts).

## Hub

`hub.yaml` says where issues live, who merges into the default branch and how the dependencies
a run needs are installed; see [Sandbox and models](../sandbox.md#dependencies).

See `Hub` in [src/schema.ts](../../src/schema.ts).

See `MergeSection` in [src/schema.ts](../../src/schema.ts).

## Human

Every hub file, local issues included, takes an optional `human` field: notes for humans, never
shown to a model and never changing the flow. It is plain text or a map of strings, such as where
the item came from. The studio shows it in the node details.

See `Human` in [src/schema.ts](../../src/schema.ts).

## Config

See `Config` in [src/config.ts](../../src/config.ts).
