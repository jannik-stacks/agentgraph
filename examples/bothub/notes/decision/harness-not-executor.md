---
title: Say harness, not executor
status: accepted
check: docs-style
---
The program that runs a bot's session (opencode, pi) is its harness: `harness:` in a bot file,
`HarnessAdapter` in `src/types.ts`, `src/harnesses/` for the adapters. Never call it an executor
in code, comments or docs.
