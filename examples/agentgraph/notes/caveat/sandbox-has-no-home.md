---
title: The sandbox user has no home directory entry
status: accepted
check: tests
human: dogfood round 2 kink K6
---
Checks run as the host's user id, which has no entry in the image's passwd file. `os.homedir()`
then reads only `HOME`, and throws when it is unset; vitest calls it at startup. A script or test
that spawns a tool with an environment it builds by hand passes `HOME` along, or sets it to its
temporary directory.

Bad:

```ts
spawnSync('vitest', args, { env: { PATH: process.env.PATH } });
```

Good:

```ts
spawnSync('vitest', args, { env: { PATH: process.env.PATH, HOME: tmp } });
```
