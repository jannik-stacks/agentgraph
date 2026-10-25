# agentgraph

agentgraph runs coding agents on the issues of a repository. You describe agents, checks and workflows in a folder of Markdown files called a hub. When someone comments `/agent` on an issue or adds a label, the engine runs the matching workflow. Each agent works in its own Docker sandbox. Scripts and judge agents check the result. The engine then pushes a branch and opens a pull request, and a person reviews and merges it.

Agents never hold a GitHub token. They return proposals, such as a comment, a push or a new issue, and the engine applies them only after the checks pass. Every run is recorded as a trace that you can read in the studio, a local web UI.

## How it works

```
   /agent comment or label on an issue
                  |
                  v
   +-----------------------------+             +-----------------------------+
   | engine, on the host         |             | sandbox, one per session    |
   | reads the hub and drives    |-- start --->| the agent edits a worktree  |
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

A hub is plain files:

```
hub/
  hub.yaml               repo and limits
  agents/implementor.md  role, harness, model, allowed proposals
  skills/implement.md    instructions handed to an agent
  checks/tests.md        a script or a judge that passes or fails a try
  workflows/issue.md     trigger and steps
```

## Commands

```sh
npm run up                   # model proxy and sandbox, see infra/local/README.md
npm run keys                 # one proxy key per agent
npx agentgraph <verb>        # start, say, review, merge, export, close, show, loop, check, dispatch, prune-logs
npm run check                # everything CI and the precommit hook run
npm run down
```

Before the first `npm run up`, copy `infra/local/.env.example` to `infra/local/.env` and set `LITELLM_MASTER_KEY` and your provider keys.

## Quickstart

You need Node 22.18 or later and Docker, and a Claude or ChatGPT login, an Anthropic key, or [the model stack](docs/local.md#the-model-stack) for `--provider litellm`. Inside any git repo:

```sh
npx agentgraph start "Add a greet function"
```

The first command makes a local instance for the repo under `~/.agentgraph`: a forge folder that stands in for GitHub, and the runs. It files the text as an issue and drives it in the foreground: implement, run the repo's tests, review, then wait for you. The branch lands in your repo as `agentgraph/1`; your checkout never moves.

```sh
npx agentgraph show                                   # what needs you
npx agentgraph review 1 changes "also greet by name"  # drives it again
npx agentgraph merge 1                                # then git merge agentgraph/1
```

Without `.agentgraph/` in the repo it uses the packaged default hub; see [Without GitHub](docs/forge.md). `npx agentgraph check --hub examples/sandbox` validates a hub without a model or container. The studio shows the workflow graph and every run: `cd studio && npm install && npm run dev -- --repo /path/to/your/repo`.

## Docs

- [What agentgraph is](docs/index.md)
- [Vocabulary](docs/vocabulary.md)
- [The loop](docs/loop.md): workflows, checks, retries and waiting for people
- [Proposals](docs/proposals.md): what agents may ask the engine to do
- [Running locally](docs/local.md): the model stack, the CLI, the GitHub App and the studio
- [Without GitHub](docs/forge.md): the local verbs, instances and forge folders
- [Hub files](docs/reference.md): every field and default
- [Architecture](docs/architecture.md)

## Examples

| Hub | Repo or purpose |
| --- | --- |
| `examples/sandbox` | A small JavaScript package; the place to start |
| `examples/agentgraph` | agentgraph itself |
| `examples/clarinet` | A Rust workspace |
| `examples/acme-app` | Acme App |
| `examples/bench` | The hub the bench replays pull requests with |

## Development

```sh
npm test
npm run lint
npm run format
npm run check         # everything: formatting, lint, unused code, docs, hubs, types, coverage, studio build
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
