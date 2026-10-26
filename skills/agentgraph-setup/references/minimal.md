# The minimal graph

The smallest `.agentgraph/` that works has five files. No agent names a harness or a model, so it runs on any
provider. Write them only when `.agentgraph/` does not exist yet.

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

```yaml
repo: owner/name
```

Take it from the GitHub remote (`git remote get-url origin`). Leave it out for a repo without one; the local
CLI does not need it.

### setup

`setup` is a shell script each checkout runs once, with network, before the first step. The sandbox caches
what it installs, keyed on the lockfiles. Use the frozen install for the lockfile `slice-repo.mjs` reported:

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

Prefer the command CI uses when it differs, such as extra flags or a workspace filter. Tools the sandbox lacks
(a Rust target, `cargo-nextest`, a Python version) go in `toolchain`, not `setup`:

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

Copy the command from the CI step that runs the tests, as CI runs it, including flags and the working folder
(`cd packages/core && npm test`). Leave out steps that need a service CI starts (a database, a browser
download, a secret). If the suite cannot run without one, run the part that can (`npm run test:unit`) and tell
the user what the check leaves out.

The body is the check's description; the implementor sees it when the check fails, so say plainly what passes.

CI often runs the tests on a matrix of versions and systems. The sandbox is one Linux machine with one version
of each tool, so the check runs the command once. Tell the user the matrix stays CI's job. When the repo needs
a tool version the sandbox lacks, install it through `toolchain`.

### base

The default workflow opens pull requests against `main`. When pull requests merge into another branch, add it
under `branch:` in `workflows/issue.md`:

```yaml
branch: agentgraph/{issue}
base: develop
```

## Validate

```sh
agi check --dir .agentgraph
```

It prints each problem with its file, or `ok`. Common problems:

- `no step or workflow names <check>`: every check must be in some step's `checks:` list.
- `no step or check names <agent>`: an agent nothing uses must go.
- `<field>: is unexpected`: an unknown key; fields are listed in the
  [graph reference](https://github.com/jannik-stacks/agentgraph/blob/main/docs/reference.md).
- `says "..." which is retired`: a word the engine renamed; use the word it suggests.

## Worked example

A TypeScript library with `package-lock.json`, and CI that runs `npm ci`, `npm run lint` and `npm test`:

```yaml
# settings.yaml
repo: acme/left-pad
setup: npm ci --no-audit --no-fund
limits:
  minutes: 30
  usd-per-run: 5
  parallel: 1
```

`checks/tests.md` keeps `mode: block` with `run: npm test`. `npm run lint` becomes a tier 1 candidate in the
mining pass; it is not part of the minimal graph.
