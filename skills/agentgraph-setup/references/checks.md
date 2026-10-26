# Check patterns

A check is `checks/<name>.md`: frontmatter that says how it decides, and a body that says what passes. The body
is what the implementor reads when the check fails, so write it as the rule, in one or two plain sentences.
A check runs only when a step lists it in `checks:`.

| Field   | Meaning                                                                                                                           |
| ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `mode`  | `block` fails the try and sends the findings back; `warn` records a failure and goes on; `info` only records; `stop` ends the run |
| `run`   | A shell command in the checkout. Exit 0 passes; its output is the findings                                                        |
| `agent` | A judge agent that reads the change and records pass or fail with a reason                                                        |
| `each`  | `files`, `hunks`, or a command whose output lines (or JSON array) are the items; the judge rules on each one                      |
| `max`   | The most items `each` may give, 20 by default; more fails the check                                                               |

Keep `run:` to one plain command. YAML frontmatter breaks on a `: ` inside an unquoted value, so anything with
quotes, colons or logic goes in a script file. You may run your own check scripts on the host to try them,
since they only read git; never run the repo's own commands there.

A one-line git command is often enough, such as a check that the change leaves `package.json` alone:

```markdown
---
mode: warn
run: git diff --quiet "$AGENTGRAPH_BASE" -- package.json
---

The change does not edit package.json.
```

Scripts get `AGENTGRAPH_BASE` (the commit the change starts from) and `AGENTGRAPH_DIR` (the graph folder, read
only). Put scripts in `.agentgraph/scripts/` and call them as `node "$AGENTGRAPH_DIR/scripts/<name>.mjs"`. The
full list of fields and variables is in the
[graph reference](https://github.com/jannik-stacks/agentgraph/blob/main/docs/reference.md) and
[the loop](https://github.com/jannik-stacks/agentgraph/blob/main/docs/loop.md#checks).

## Tier 1: a tool CI already runs

The exact command from CI, run on the whole repo the way CI runs it.

```markdown
---
mode: block
run: npx tsc --noEmit
---

The whole repo typechecks with its own tsconfig, as CI's `typecheck` job runs it.
```

When the tool is slow or the repo already fails it on files the change does not touch, run it on touched files
only. The sandbox installs dependencies through `setup`, so `node_modules/.bin` is there:

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

Copy `assets/changes.mjs` to `.agentgraph/scripts/changes.mjs` for `existingFiles`, `touchedFiles` and
`lineChanges`. Format checks follow the same shape with the formatter's check flag (`prettier --check`,
`cargo fmt --check`, `ruff format --check`).

## Tier 2: a tool the repo has that CI does not gate

Same shapes as tier 1, with `mode: warn`. Name where the command comes from in the body ("the `lint:md` script
in package.json"). It moves to `block` once runs show it fires on real problems.

## Tier 3: a reviewer rule a script decides

Copy `assets/rules.mjs` next to `changes.mjs` and fill in one rule per enforced review habit. It fails only
when a change adds more hits than it removes, so a moved line passes and old code does not fail new work.

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

Keep the evidence (pull request numbers) in your summary, not in the message: the message is for the agent.

## Tier 4: a judgement over script-listed items

A script lists the items; a judge answers one narrow question per item. The narrower the question, the smaller
the model it needs. Add a judge agent with read-only tools:

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

`each: files` gives one item per changed file and `each: hunks` one per diff hunk. For narrower items, write a
script that prints one JSON line per item (each new export, each new dependency in a manifest) and set
`each: node "$AGENTGRAPH_DIR/scripts/<name>.mjs"`.

A judge over the whole change, with no `each`, is the last resort. Give it one question, not a checklist.

## Modes and evidence

New checks start as `warn`, except tier 1. Moving one to `block` is a graph edit that needs evidence from real
runs: the check failed where a human would have asked for the same change, and passed where they did not. Until
then it is a proposal. `agi check <name> --runs` reruns a check on runs that already ended.
