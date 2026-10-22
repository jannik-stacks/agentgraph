---
title: Read a model's answer by how it starts, not by exact lines
status: accepted
check: tests
human: review-docs run f074e5 in dogfood round 5 answered "FAIL <file:line>" and was logged as no verdict
---
A model asked to put a word on a line of its own often adds the reason after it on the same line,
in any case and behind bold, a colon or a dash. Code that reads a model's answer matches the word
the answer starts with, as a whole word, and keeps the rest of that line. An answer that only
mentions the word later, or a longer word that starts with it, still counts as no answer.

Bad:

```ts
const word = first.replace(/[\s*_]/g, '').toUpperCase();
if (word !== 'PASS' && word !== 'FAIL') return noVerdict;
```

Good:

```ts
const verdict = /^[\s*_]*(pass|fail)\b[\s*_]*[:.\-–—]?\s*(.*)$/i.exec(first);
if (!verdict) return noVerdict;
```
