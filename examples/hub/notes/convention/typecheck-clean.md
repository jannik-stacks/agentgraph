---
title: The project typechecks with no errors
status: accepted
check: types
paths: ['**/*.ts']
---

Every change keeps `tsc --noEmit` clean. Do not silence errors with casts or `any`.
