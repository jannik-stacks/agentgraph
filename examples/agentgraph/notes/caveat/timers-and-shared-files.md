---
title: Timers fire early and shared files are read mid-write
status: accepted
check: tests
human: flaky serve test fix, retry timer fired early and queue files were read mid-write
---
A `setTimeout` runs on the event loop clock, so it can fire a millisecond before the `Date.now()`
deadline it was armed for. Code that sleeps until something is due must check again when it wakes
and arm a new wait for whatever is still not due, never assume the wake means due.

The queue, the run store and the pull log are read while other code writes them. Write such a file
to a dot-prefixed temp file next to it and `rename` it into place, so a reader sees the old file or
the new one, never half of one.

A test that fails one time in twenty is a race, in the code or in what the test waits for. Wait on
the condition the test asserts, never on a sleep or a longer timeout.

Bad:

```ts
setTimeout(() => run(job), job.dueAt - Date.now());
writeFileSync(queueFile, JSON.stringify(queue));
```

Good:

```ts
const wake = () => {
  const wait = job.dueAt - Date.now();
  if (wait > 0) return setTimeout(wake, wait);
  run(job);
};
setTimeout(wake, job.dueAt - Date.now());

const tmp = join(dirname(queueFile), `.${basename(queueFile)}.tmp`);
writeFileSync(tmp, JSON.stringify(queue));
renameSync(tmp, queueFile);
```
