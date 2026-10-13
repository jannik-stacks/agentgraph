---
title: One spinner per running thing
status: accepted
source: dashboard review
check: studio-ui
---
A running run shows one spinner. Its jobs breathe and its events show a dot, so the levels look
different and the eye finds the one thing that moves. Draw every status with `StatusIcon` and the
`level` it sits at; `animate-spin`, `animate-pulse` and `animate-ping` live only in
`dashboard/bits.tsx` and `studio/icons.tsx`.
