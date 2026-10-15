# Issues and context

Where the work lives and what a run gets to read.

Issues hold the work: the task a `/bothub` comment starts from, plans, specs and every question a
bot could not answer alone. One interface has two backends, `githubIssues` and

`localIssues` (Markdown files in the hub), and `hub.yaml` picks one.

The fields are on `Issues` in [src/issues.ts](../../src/issues.ts).

## Context

A run reads in three ways, and none writes. Preload is rendered into the prompt before the run:
the triggering issue and its links (`issueContext`). What a run takes in, uses and
returns is worked out by one function, shared by the pipeline and the studio.

See `runContext` in [src/preload.ts](../../src/preload.ts).

Before the first model turn, the opencode `surfacer` plugin surfaces accepted notes and
summaries of earlier runs, searched with the brief or the issue (`recallQuery`).

`weigh` ranks them with BM25, lets a judge model drop those under the cutoff when one is set, and keeps the
best within the budget.

See `weigh` in [src/recall.ts](../../src/recall.ts).

Tools are served on demand by the bothub MCP server, `serveMcp`, which opencode starts
as an MCP entry. pi has no MCP client and no plugins, so a pi bot only gets preload. The concepts
are on [Context](../context.md).
