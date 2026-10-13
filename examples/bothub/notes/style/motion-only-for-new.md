---
title: Motion only for what is new
status: accepted
source: dashboard review
check: studio-ui
---
A row animates in once, when it first arrives. A re-render, a filter change, a reconnect or a page
load animates nothing. `useEnter` in `dashboard/bits.tsx` remembers which keys were seen; an enter
class on every row of a list is the mistake it prevents.
