---
title: The dashboard streams from the run files as they are written
status: accepted
check: tests
human: dashboard work, live stream contract
---
`GET /api/stream` watches the data directory and tails each run's `events.jsonl` by byte offset,
so the dashboard only stays live while these hold:

- `events.jsonl` is append-only, one JSON record per line, each with a `seq` that grows by one.
  Rewriting or truncating the file makes the stream resend everything.
- `run.json` and `outcome.json` are replaced whole, never edited in place across two writes.
- A harness reports a `usage` event per model call with `inputTokens` (cached input included),
  `outputTokens`, and `cachedInputTokens`, `reasoningTokens` and `costUsd` when it knows them.
  The run list's tallies and every cost the dashboard shows are folded from these.
- `src/usage.ts` runs in the browser too, so it must not import Node builtins.

Bad:

```ts
writeFileSync(eventsFile, events.map(e => JSON.stringify(e)).join('\n'));
```

Good:

```ts
appendFileSync(eventsFile, `${JSON.stringify({ seq: last + 1, ...event })}\n`);
```
