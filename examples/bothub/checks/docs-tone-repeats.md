---
type: decide
description: A docs hunk says each thing once.
over: each-hunk
paths: [studio/content/docs/**]
threshold: 0.7
mode: shadow
---
Does each sentence this docs hunk adds say something that no sentence before it in the hunk already
says?
