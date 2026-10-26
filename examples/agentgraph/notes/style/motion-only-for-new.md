---
title: Motion only for what is new
status: accepted
source: dashboard review
check: code-shape
human: user dashboard feedback
---
A row animates in once, when it first arrives. A re-render, a filter change, a reconnect or a page
load animates nothing. `useEnter` in `dashboard/bits.tsx` remembers which keys were seen; an enter
class on every row of a list is the mistake it prevents.

Bad:

```tsx
{runs.map(run => (
  <li key={run.id} className="agi-enter">{run.id}</li>
))}
```

Good:

```tsx
const Row = ({ run }: { run: Run }) => <li className={useEnter(run.id)}>{run.id}</li>;
```
