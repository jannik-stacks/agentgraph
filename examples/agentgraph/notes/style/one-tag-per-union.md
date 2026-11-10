---
title: A union's members share one tag key
status: accepted
source: schema review
check: code-shape
human: user feedback type enum
---
A tagged Effect `Schema.Union` tags every member with the same key, and TypeScript narrows it with a
`switch` on that key. Proposals, said proposals and events use `kind`; harness pieces use `type`. A new
member uses the key its union already has. A new union picks the key of its neighbours.

Bad:

```ts
const Step = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('bot'), bot: Schema.String }),
  Schema.Struct({ type: Schema.Literal('script'), run: Schema.String }),
]);
```

Good:

```ts
const Step = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('bot'), bot: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('script'), run: Schema.String }),
]);

switch (step.kind) {
  case 'bot': return runBot(step.bot);
  case 'script': return runScript(step.run);
}
```
