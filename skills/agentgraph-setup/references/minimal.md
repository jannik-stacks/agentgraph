# The minimal graph

The smallest `.agentgraph/` that works is the default graph agentgraph ships, with the repo's install and test
commands filled in. Copy it from the package rather than retyping it, so it stays in step with the engine:

```sh
cp -R <agentgraph>/default .agentgraph
```

`<agentgraph>` is the checkout the user named, or the installed package folder
(`node_modules/agentgraph` in a project that depends on it).

## What the default holds

```
.agentgraph/
  settings.yaml            limits: minutes, usd-per-run, parallel
  workflows/issue.md       implement (tries 3, checks [tests]), review (back to implement once), merge (wait for a human)
  agents/implementor.md    edits the repo; may comment, push, open a pull request or ask
  agents/reviewer.md       reads the diff; may comment or send the change back
  checks/tests.md          block: runs the repo's test command
```

The workflow starts on an issue labelled `agent:ready` or a `/agent` comment, and works on the branch
`agentgraph/<issue>`.

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

| Lockfile | setup |
| --- | --- |
| `package-lock.json` | `npm ci --no-audit --no-fund` |
| `pnpm-lock.yaml` | `corepack enable && pnpm install --frozen-lockfile` |
| `yarn.lock` | `corepack enable && yarn install --immutable` (Yarn 2 or later), `yarn install --frozen-lockfile` (Yarn 1) |
| `bun.lock`, `bun.lockb` | `bun install --frozen-lockfile` |
| `uv.lock` | `uv sync --frozen` |
| `poetry.lock` | `poetry install --no-interaction` |
| `requirements*.txt` | `python -m venv .venv && .venv/bin/pip install -r requirements.txt` |
| `go.sum` | `go mod download` |
| `Cargo.lock` | none; a root `Cargo.toml` makes the sandbox install Rust and fetch crates |

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
AG check --dir .agentgraph
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
