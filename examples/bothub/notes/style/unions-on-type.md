---
title: Unions are told apart by type
status: accepted
source: schema review
check: code-shape
human: user feedback type enum, feedback rule 14
---
Every hub file kind is a zod `discriminatedUnion` on `type`, and TypeScript narrows it with
`switch (x.type)`. New unions use the same key, so one reading habit covers the schema, the
types and the code that matches on them.
