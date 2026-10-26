# Check patterns

A check is `checks/<name>.md`: frontmatter that says how it decides, and a body the implementor reads when it
fails, so write the rule in one or two plain sentences. A check runs only when a step lists it in `checks:`.

| Field   | Meaning                                                                                                                           |
| ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `mode`  | `block` fails the try and sends the findings back; `warn` records a failure and goes on; `info` only records; `stop` ends the run |
| `run`   | A shell command in the checkout. Exit 0 passes; its output is the findings                                                        |
| `agent` | A judge agent that reads the change and records pass or fail with a reason                                                        |
| `each`  | `files`, `hunks`, or a command whose output lines (or JSON array) are the items; the judge rules on each one                      |
| `max`   | The most items `each` may give, 20 by default; more fails the check                                                               |

Keep `run:` to one plain command; YAML breaks on an unquoted `: `, so anything with quotes, colons or logic
goes in a script file. On the host you may try your own git-reading scripts, never the repo's code.

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

## Tier 1: a tool CI already runs

The exact command from CI, run on the whole repo the way CI runs it.

```markdown
---
mode: block
run: npx tsc --noEmit
---

The whole repo typechecks with its own tsconfig, as CI's `typecheck` job runs it.
```

When the tool is slow, or the repo already fails it elsewhere, run it on touched files only. `setup` installs
the dependencies, so `node_modules/.bin` is there:

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

Copy `assets/changes.mjs` to `.agentgraph/scripts/` for `existingFiles`, `touchedFiles` and `lineChanges`.
Format checks use the formatter's check flag (`prettier --check`, `cargo fmt --check`).

## Tier 2: a tool the repo has that CI does not gate

Same shapes, with `mode: warn`, and the body names where the command comes from.

## Tier 3: a reviewer rule a script decides

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

A script lists the items; a judge answers one narrow question per item, so a small model will do. Add a judge
agent with read-only tools:

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

`each: files` gives one item per changed file, `each: hunks` one per hunk. For narrower items, a script prints
one JSON line per item: `each: node "$AGENTGRAPH_DIR/scripts/<name>.mjs"`. A judge over the whole change is
the last resort, with one question, not a checklist.

## Modes and evidence

New checks start as `warn`, except tier 1. One moves to `block` only on evidence from real runs: it failed
where a human would have asked for the same change, and passed where they would not. `agi check <name> --runs`
reruns a check on ended runs.
