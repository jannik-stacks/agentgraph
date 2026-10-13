---
title: Nothing flashes or jumps while it loads
status: accepted
source: dashboard and docs review
check: code-shape
human: user dashboard feedback, feedback rule 8
---
Opening a tab, a docs page or a source view is static and fast. A Suspense fallback keeps the
space the content will take and says nothing; "Loading" text is a flash. Markdown is imported
statically where it shows, and highlighting must not change the height of a block. Dragging the
graph moves nodes without re-rendering the rest of it.
