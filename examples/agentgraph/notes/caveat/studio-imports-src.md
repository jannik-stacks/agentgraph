---
title: The studio runs parts of src in the browser
status: accepted
check: studio-build
human: user feedback on the node:crypto browser error
---
The studio imports `src/graph.ts`, `src/workflow.ts`, `src/store.ts`, `src/folder.ts` and everything they
import. Those modules must not import Node builtins, not even
for one helper. Keep schemas and pure functions in modules without them, and put the code that
reads files, hashes or spawns in its own module that only the server imports.

Bad:

```ts
// src/graph.ts, which the studio imports
import { createHash } from 'node:crypto';
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
```

Good:

```ts
// src/digest.ts, imported only by the server
import { createHash } from 'node:crypto';
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');

// src/graph.ts keeps schemas and pure functions
```
