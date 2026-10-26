# Check patterns

A check is `checks/<name>.md`: frontmatter that says how it decides, and a body the implementor reads when it
fails, so write the rule in one or two plain sentences. A check runs only when a step lists it in `checks:`.

`mode` is `block` (fail the try, send findings back), `warn` (record and go on), `info` or `stop`. `run` is a
shell command, exit 0 passes. `agent` is a judge. `each` and `max` fan a judge out over items.

Keep `run:` to one plain command; anything with quotes, colons or logic goes in a script file. On the host you may try your own git-reading scripts, never the repo's code.

A one-line git command is often enough:

```markdown
---
mode: warn
run: git diff --quiet "$AGENTGRAPH_BASE" -- package.json
---

The change does not edit package.json.
```

Scripts get `AGENTGRAPH_BASE` (the commit the change starts from) and `AGENTGRAPH_DIR` (the graph folder, read
only). Put them in `.agentgraph/scripts/` and call them as `node "$AGENTGRAPH_DIR/scripts/<name>.mjs"`. Every
field and variable is in the [graph reference](https://github.com/jannik-stacks/agentgraph/blob/main/docs/reference.md)
and [Checks and results](https://github.com/jannik-stacks/agentgraph/blob/main/docs/checks.md).

## Tiers 1 and 2: a repo tool

Tier 1 is a tool CI runs on every change, with CI's exact command, as `block`. Tier 2 is a tool the repo has
but CI does not gate, same shapes, as `warn`, with the body naming where the command comes from.

```markdown
---
mode: block
run: npx tsc --noEmit
---

The whole repo typechecks with its own tsconfig, as CI's `typecheck` job runs it.
```

When the tool is slow or already fails elsewhere, run it on touched files only:

```js
// .agentgraph/scripts/lint.mjs
import { spawnSync } from 'node:child_process';
import { existingFiles } from './changes.mjs';

const files = existingFiles(/\.(ts|tsx|js|mjs)$/);
if (!files.length) process.exit(0);
const result = spawnSync('node_modules/.bin/eslint', ['--max-warnings=0', ...files], { encoding: 'utf8' });
if (result.status !== 0) console.log(`${result.stdout}${result.stderr}`.trim());
process.exit(result.status ?? 1);
```

`assets/changes.mjs` goes to `.agentgraph/scripts/` for `existingFiles`, `touchedFiles` and `lineChanges`.

## Tier 3: a reviewer rule a script decides

A rule reviewers enforced at least twice that a script decides on added lines, as `warn`.

Copy `assets/rules.mjs` next to `changes.mjs`, with one rule per enforced review habit. It fails only when a
change adds more hits than it removes, so moved lines and old code pass.

```js
const rules = [
  { files: /^src\/.*\.ts$/, hit: /:\s*any\b|\bas any\b/, message: 'use a real type, not any' },
  { files: /^src\//, hit: /console\.log\(/, message: 'log through src/log.ts' },
];
```

```markdown
---
mode: warn
run: node "$AGENTGRAPH_DIR/scripts/rules.mjs"
---

The change adds no new case of what reviewers ask to remove: `any` in src/ and `console.log` outside src/log.ts.
```

Pull request numbers go in your summary, not the message; the message is for the agent.

## Tier 4: a judgement over script-listed items

A script lists items; a judge with read-only tools answers one narrow question each:

```markdown
---
tools: [read, grep, glob]
---

You answer one yes-or-no question about one item of a change. The item holds what you need; read code only
when the question asks you to. Decide, then record your result once. When it fails, say the file, the line
and the smallest fix.
```

Saved as `agents/checker.md`, then the check:

```markdown
---
mode: warn
agent: checker
each: hunks
max: 30
---

Does this hunk add a public function without a doc comment that says what it returns? Pass when it adds none.
```

`each: files` gives one item per changed file, `each: hunks` one per hunk, and
`each: node "$AGENTGRAPH_DIR/scripts/<name>.mjs"` one per JSON line it prints. A judge over the whole change
is the last resort, with one question.

## Modes and evidence

New checks start as `warn`, except tier 1. One moves to `block` only on evidence from real runs: it failed
where a human would have asked for the same change, and passed where they would not. `agi check <name> --runs`
reruns a check on ended runs.
