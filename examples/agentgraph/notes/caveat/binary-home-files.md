---
title: A run home holds binary files
status: accepted
check: tests
human: resume session, opencode keeps sessions in SQLite
---
A harness keeps its sessions in its run home, and opencode keeps them in a SQLite file. Code that
rewrites home files, such as masking secrets, must not decode them as UTF-8: one rewrite corrupts
the database, and the next run that continues the session fails. A file with a NUL byte is
binary; mask it with a replacement of the same byte length, and leave every other byte as it was.

Bad:

```ts
const text = await readFile(file, 'utf8');
await writeFile(file, mask(text));
```

Good:

```ts
const content = await readFile(file);
const binary = content.includes(0);
const text = content.toString(binary ? 'latin1' : 'utf8');
await writeFile(file, binary ? sameLength(text) : mask(text), binary ? 'latin1' : 'utf8');
```
