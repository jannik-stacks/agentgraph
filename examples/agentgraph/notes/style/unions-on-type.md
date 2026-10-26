---
title: Unions are told apart by type
status: accepted
source: schema review
check: code-shape
human: user feedback type enum
---
Every hub file kind is an Effect `Schema.Union` of structs tagged by `type`, and TypeScript narrows it with
`switch (x.type)`. New unions use the same key, so one reading habit covers the schema, the
types and the code that matches on them.

Bad:

```ts
const Step = Schema.Union(
  Schema.Struct({ kind: Schema.Literal('bot'), bot: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('script'), run: Schema.String }),
);
```

Good:

```ts
const Step = Schema.Union(
  Schema.Struct({ type: Schema.Literal('bot'), bot: Schema.String }),
  Schema.Struct({ type: Schema.Literal('script'), run: Schema.String }),
);

switch (step.type) {
  case 'bot': return runBot(step.bot);
  case 'script': return runScript(step.run);
}
```
