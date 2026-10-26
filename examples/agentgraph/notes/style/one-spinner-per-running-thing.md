---
title: One spinner per running thing
status: accepted
source: dashboard review
check: code-shape
human: user dashboard feedback
---
A running run shows one spinner. Its jobs breathe and its events show a dot, so the levels look
different and the eye finds the one thing that moves. Draw every status with `StatusIcon` and the
`level` it sits at; `animate-spin`, `animate-pulse` and `animate-ping` live only in
`dashboard/bits.tsx` and `studio/icons.tsx`.

Bad:

```tsx
{jobs.map(job => (
  <Loader2 key={job.id} className="size-3.5 animate-spin" />
))}
```

Good:

```tsx
{jobs.map(job => (
  <StatusIcon key={job.id} status={job.status} level="job" />
))}
```
