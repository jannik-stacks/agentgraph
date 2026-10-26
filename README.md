# agentgraph

agentgraph runs coding agents on the issues of a repository. You describe agents, checks and workflows in `.agentgraph/`, a folder of Markdown files in the repo. When someone comments `/agent` on an issue or adds a label, the engine runs the matching workflow. Each agent works in its own Docker sandbox. Scripts and judge agents check the result. The engine then pushes a branch and opens a pull request, and a person reviews and merges it.

Agents never hold a GitHub token. They return proposals, such as a comment, a push or a new issue, and the engine applies them only after the checks pass. Every run is recorded as a trace that you can read in the studio, a local web UI.

## How it works

```
   /agent comment or label on an issue
                  |
                  v
   +-----------------------------+             +-----------------------------+
   | engine, on the host         |             | sandbox, one per session    |
   | reads the graph and drives  |-- start --->| the agent edits a worktree  |
   | the workflow step by step   |<-proposals--| and calls models via proxy  |
   +-----------------------------+             +-----------------------------+
          |                ^
          v                | failed: feedback, next try
   +-----------------------------+
   | checks: scripts, then judge |
   | agents, in parallel         |
   +-----------------------------+
          |
          v passed
   push the branch, open a pull request, wait for a person to merge
```

The folder is plain files:

```
.agentgraph/
  settings.yaml          repo and limits
  agents/implementor.md  role, harness, model, allowed proposals
  skills/implement.md    instructions handed to an agent
  checks/tests.md        a script or a judge that passes or fails a try
  workflows/issue.md     trigger and steps
```

## Quickstart

You need:

- Linux or macOS with Docker, used as a user in the `docker` group. agentgraph does not run as root. The sandbox image takes about 2.4 GB.
- Node 24 or later.
- git with `user.name` set. The first command makes it the one login the repo's local instance trusts.
- An Anthropic API key, or one of the [other model routes](#other-model-routes).

The command is `agi`, from the npm package `@jannik-stacks/agi`. Run it without installing as `npx @jannik-stacks/agi <verb>`, or install it once with `npm install -g @jannik-stacks/agi`. The unscoped `agentgraph` package on npm is unrelated.

Inside the git repo you want agents to work on:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
agi start --provider anthropic --save "Add a mul function next to add, with a test"
```

The first start builds the sandbox image, which takes about 3 minutes. It makes a local instance for the repo under `~/.agentgraph`: a forge folder that stands in for GitHub, and the runs. It files the text as an issue and drives it in the foreground: implement, run the repo's tests, review, then wait for you. The branch lands in your repo as `agentgraph/1`; your checkout never moves. `--save` keeps the provider for later commands.

```sh
agi show                                    # what needs you
agi review 1 changes "also cover a negative"  # drives it again
agi merge 1                                   # then git merge agentgraph/1
```

`agi --help` lists every verb.

### Your own graph

Without `.agentgraph/` the repo gets the packaged default graph, which `agi show graph` lists. This one is smaller and runs on any provider, because no agent names a harness or a model:

```yaml
# .agentgraph/settings.yaml
limits:
  minutes: 10
  usd-per-run: 1
  parallel: 1
```

```md
<!-- .agentgraph/agents/implementor.md -->
---
tools: [read, edit, write, bash, grep, glob]
returns: [comment, push, pull_request, ask]
---
You make the smallest change to this TypeScript repo that does what the issue asks, with a test.
```

```md
<!-- .agentgraph/skills/implement.md -->
---
description: Implement one small issue
---
Add the code under src/ and a test under test/. Run npm test. Open a pull request when it passes.
```

```md
<!-- .agentgraph/checks/tests.md -->
---
mode: block
run: npm test
---
The test suite passes.
```

```md
<!-- .agentgraph/workflows/issue.md -->
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

`agi check --dir .agentgraph` validates it without a model or container, and `start --dir .agentgraph` runs it before you commit it. Once committed, runs read the committed version. [Graph files](docs/reference.md) lists every field.

### Other model routes

- A Claude subscription: `--provider claude` runs `claude setup-token` on the host once and keeps the token. It needs the `claude` CLI.
- LiteLLM, the local model stack, for opencode, pi and Codex and for a ChatGPT login, OpenRouter or Ollama. It runs from a clone of this repo:

```sh
cp infra/local/.env.example infra/local/.env   # set LITELLM_MASTER_KEY and your provider keys
npm run up                                     # LiteLLM, Postgres and egress, waits until healthy
npm run keys -- local                          # one proxy key for every agent, in infra/local/.keys.env.local
set -a; . infra/local/.keys.env.local; set +a
agi start --provider litellm "..."
```

LiteLLM's default models need a ChatGPT login; [Local infrastructure](infra/local/README.md) covers it and the other upstreams. `npm run down` stops the stack.

The studio shows the workflow graph and every run, also from a clone: `cd studio && npm install && npm run dev -- --repo /path/to/your/repo`.

### From source

```sh
git clone https://github.com/jannik-stacks/agentgraph ~/agentgraph
npm ci --prefix ~/agentgraph && npm link --prefix ~/agentgraph
```

This puts the `agi` of your clone on your PATH. If `npm link` fails with `EACCES`, run `npm config set prefix ~/.local` once and put `~/.local/bin` on your PATH.

## Docs

- [What agentgraph is](docs/index.md)
- [Vocabulary](docs/vocabulary.md)
- [The loop](docs/loop.md): workflows, checks, retries and waiting for people
- [Proposals](docs/proposals.md): what agents may ask the engine to do
- [Running locally](docs/local.md): the CLI, the model stack, the GitHub App and the studio
- [Without GitHub](docs/forge.md): the local verbs, instances and forge folders
- [Graph files](docs/reference.md): every field and default
- [Architecture](docs/architecture.md)

## Examples

| Example | Repo or purpose |
| --- | --- |
| `examples/sandbox` | The graph of a small JavaScript package on GitHub: triage, stacked pull requests and cross-checking reviews |
| `examples/agentgraph` | agentgraph itself |
| `examples/bench` | The graph the bench replays pull requests with |

## Development

```sh
npm test
npm run lint
npm run format
npm run check         # everything: formatting, lint, unused code, docs, graphs, types, coverage, studio build
```

`npm run check:docs` checks that docs references and documented commands match the code. `npm run hooks` enables the git hooks in `bin/hooks`, which run `npm run check` and the commit message rules. Undo with `git config --unset core.hooksPath`.

`bin/lsp.ts` gives you the editor's find references and rename from the shell. It talks to the TypeScript language server that ships with the `typescript` dev dependency, so there is nothing extra to install. Positions are `file:line:col`, counted from 1, and paths are relative to the directory you run it in.

```sh
node bin/lsp.ts refs src/disk.ts:374:14
node bin/lsp.ts rename src/disk.ts:374:14 roomLeft --dry   # print the edits, change nothing
node bin/lsp.ts rename-symbol inventory listItems          # find the declaration by name; fails if the name is ambiguous
```

## License

MIT, see [LICENSE](LICENSE).
