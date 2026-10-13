---
type: decide
description: A docs hunk states facts without selling them.
over: each-hunk
paths: [studio/content/docs/**]
threshold: 0.7
mode: shadow
human: one question per check, safety-checks item 10 split of docs-tone
---
Are the lines this docs hunk adds plain statements of fact, free of praise, hype and selling words?
