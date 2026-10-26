# The minimal graph

The smallest working `.agentgraph/` is the default graph with the repo's install and test commands filled in.
Copy it from the package (`cp -R "$AGI_PKG/default" .agentgraph`) so it stays in step with the engine. It
names no harness or model, so it runs on any provider.

## What the default holds

```
.agentgraph/
  settings.yaml            limits, plus repo and setup below
  agents/implementor.md    edits the repo; may comment, push, open a pull request or ask
  skills/implement.md      how this repo wants a change made and tested
  checks/tests.md          block: runs the repo's test command
  workflows/issue.md       implement with the tests check, then wait for a human to merge
```

The workflow starts on an issue labelled `agent:ready` or a `/agent` comment, and works on the branch
`agentgraph/<issue>`.

```yaml
# settings.yaml
limits:
  minutes: 10
  usd-per-run: 1
  parallel: 1
```

```md
<!-- agents/implementor.md -->
---
tools: [read, edit, write, bash, grep, glob]
returns: [comment, push, pull_request, ask]
---
You make the smallest change to this repo that does what the issue asks, with a test.
```

```md
<!-- skills/implement.md -->
---
description: Implement one small issue
---
Add the code and a test where this repo keeps them. Run <the test command>. Open a pull request when it passes.
```

```md
<!-- workflows/issue.md -->
---
on: { issues: { label: agent:ready }, issue_comment: {} }
branch: agentgraph/{issue}
steps:
  implement:
    agent: implementor
    checks: [tests]
  merge: { wait: human, back: implement }
---
One issue, one pull request, a human merges.
```

In the skill, name the folders the repo really uses (`src/` and `test/`, `crates/*/tests`) and the test
command from `checks/tests.md`.

## The edits

### repo

`repo: owner/name`, from `git remote get-url origin`; leave it out without a GitHub remote.

### setup

`setup` runs once per checkout, with network, before the first step; its installs are cached by lockfile.
Use the frozen install for the lockfile `slice-repo.mjs` reported:

| Lockfile                | setup                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| `package-lock.json`     | `npm ci --no-audit --no-fund`                                                                              |
| `pnpm-lock.yaml`        | `corepack enable && pnpm install --frozen-lockfile`                                                        |
| `yarn.lock`             | `corepack enable && yarn install --immutable` (Yarn 2 or later), `yarn install --frozen-lockfile` (Yarn 1) |
| `bun.lock`, `bun.lockb` | `bun install --frozen-lockfile`                                                                            |
| `uv.lock`               | `uv sync --frozen`                                                                                         |
| `poetry.lock`           | `poetry install --no-interaction`                                                                          |
| `requirements*.txt`     | `python -m venv .venv && .venv/bin/pip install -r requirements.txt`                                        |
| `go.sum`                | `go mod download`                                                                                          |
| `Cargo.lock`            | none; a root `Cargo.toml` makes the sandbox install Rust and fetch crates                                  |

Prefer CI's command when it differs. Tools the sandbox lacks (a Rust target, `cargo-nextest`, a Python
version) go in `toolchain`:

```yaml
toolchain: rustup target add wasm32-unknown-unknown
```

### checks/tests.md

```markdown
---
mode: block
run: npm test
---

The test suite passes, as CI runs it in .github/workflows/ci.yml.
```

Copy CI's test command with its flags and folder (`cd packages/core && npm test`). Leave out steps that need a
service CI starts (a database, a browser, a secret); run the part that can (`npm run test:unit`) and tell the
user what is left out. The body is what the implementor sees on failure, so say plainly what passes.

The sandbox is one Linux machine with one version of each tool, so a CI matrix stays CI's job; say so.

### base

When pull requests merge into a branch other than `main`, add it in `workflows/issue.md`:

```yaml
branch: agentgraph/{issue}
base: develop
```

## Validate

```sh
agi check --dir .agentgraph
```

It prints `ok`, or each problem with its file:

- `no step or workflow names <check>`: every check must be in some step's `checks:` list.
- `no step or check names <agent>`: an agent nothing uses must go.
- `<field>: is unexpected`: an unknown key; see the
  [graph reference](https://github.com/jannik-stacks/agentgraph/blob/main/docs/reference.md).
- `says "..." which is retired`: a word the engine renamed; use the word it suggests.

## Worked example

A TypeScript library with `package-lock.json` whose CI runs `npm ci`, `npm run lint` and `npm test` adds two
lines to `settings.yaml`, `repo: acme/left-pad` and `setup: npm ci --no-audit --no-fund`, and keeps
`checks/tests.md` at `run: npm test`. `npm run lint` becomes a tier 1 candidate later.
