---
title: Unions are told apart by type
status: accepted
source: schema review
check: code-shape
human: user feedback type enum, feedback rule 14
---
Every hub file kind is a zod `discriminatedUnion` on `type`, and TypeScript narrows it with
`switch (x.type)`. New unions use the same key, so one reading habit covers the schema, the
types and the code that matches on them.

Bad:

```ts
const Step = z.union([
  z.object({ kind: z.literal('bot'), bot: z.string() }),
  z.object({ kind: z.literal('script'), run: z.string() }),
]);
```

Good:

```ts
const Step = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bot'), bot: z.string() }),
  z.object({ type: z.literal('script'), run: z.string() }),
]);

switch (step.type) {
  case 'bot': return runBot(step.bot);
  case 'script': return runScript(step.run);
}
```
