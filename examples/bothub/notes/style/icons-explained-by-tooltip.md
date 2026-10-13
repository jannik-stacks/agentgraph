---
title: Every icon is explained by a tooltip
status: accepted
source: dashboard review
check: studio-ui
---
An icon, a count or a control that shows no words gets a `Tooltip` that says what it is or does.
The native `title` attribute is slow, unstyled and missing on touch, so it is not used outside
`ui.tsx`. The tooltip adds what the label does not say, such as the exact value behind a rounded
one.
