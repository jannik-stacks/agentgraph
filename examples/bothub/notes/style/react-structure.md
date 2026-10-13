---
title: React structure
status: accepted
source: Vercel React practices
check: code-shape
human: user invoked Vercel React practices, feedback rule 9
---
Components are defined at module level, never inside another component. Routes and heavy views
load with `lazy(() => import(...))` from `App.tsx`, so the first paint carries only the shell.
Values that follow from props or state are computed while rendering, not copied into state by an
effect.
