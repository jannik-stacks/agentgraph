---
title: Scripts under bin are ES modules
status: accepted
---

The package is `"type": "module"`, so `require` fails in `bin/`. Use `import`, and
`import.meta.dirname` instead of `__dirname`.
