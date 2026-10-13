---
title: Docs show excerpts tied to symbols
status: accepted
source: docs review
check: rules
human: user feedback on excerpts, feedback rule 10
---
A docs page shows the few lines a reader needs, through `<Source file="..." symbol="..." />`, so
the excerpt follows the code when it changes. Whole files are shown only for small config files
such as `package.json`. A source view opens collapsed.

Bad:

```mdx
<Source file="src/config.ts" />
```

Good:

```mdx
<Source file="src/config.ts" symbol="Defined" />
```
