---
type: decide
description: A docs hunk adds no tagline after a dash at the end of a sentence.
over: each-hunk
paths: [studio/content/docs/**]
threshold: 0.7
mode: shadow
human: one question per check, safety-checks item 10 split of docs-tone
---
Does every sentence this docs hunk adds end without a dash followed by a short tagline or punchline?
