---
title: Shared primitives over local copies
status: accepted
source: studio review
check: code-shape
human: user feedback reuse docs markdown engine, feedback rule 17
---
`ui.tsx` holds the controls the studio repeats: `Select` with its chevron spaced from the text,
`RemovableChip` with the remove button inside its border, `Tooltip`, `Button`, `Chip` and
`Segmented`. Markdown renders through the docs engine in `Markdown.tsx`, styled like the docs
site, and JSON with a known shape renders as fields rather than raw text. A new control that two
views need goes into `ui.tsx`, not into either view.
