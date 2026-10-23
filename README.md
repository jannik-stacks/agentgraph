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
npx agentgraph <command>     # check, --all, loop, status, say, tell, dispatch
npm run check                # everything CI and the precommit hook run
npm run down
```

Before the first `npm run up`, copy `infra/local/.env.example` to `infra/local/.env` and set `LITELLM_MASTER_KEY` and your provider keys.

## Quickstart

You need Node 22.18 or later. Running agents also needs Docker.

```sh
npm install
npx agentgraph check --hub examples/sandbox
```

`check` validates a hub. It needs no model and no container, and prints `ok` or the problems it found.

To try a repo without GitHub, create a local instance. It holds a copy of the hub, a forge folder that stands in for GitHub, and a data directory. Your repo stays untouched until you export a branch.

```sh
node bin/forge.ts ~/agentgraph/demo init /path/to/your/repo --hub examples/sandbox
node bin/forge.ts ~/agentgraph/demo issue "Add a greet function" --label agent:ready
node bin/forge.ts ~/agentgraph/demo show
npx agentgraph status --instance ~/agentgraph/demo
```

To let agents work on that issue, run `npm run up` and `npm run keys`, copy the keys into the instance as [Set one up](docs/local.md#set-one-up) shows, then run every open issue once and look at the result:

```sh
npx agentgraph --instance ~/agentgraph/demo --all
node bin/forge.ts ~/agentgraph/demo show 2
cd studio && npm install && npm run dev -- --instance ~/agentgraph/demo
```

The studio opens on port 5182 and shows the workflow graph and every run.

## Docs

- [What agentgraph is](docs/index.md)
- [Vocabulary](docs/vocabulary.md)
- [The loop](docs/loop.md): workflows, checks, retries and waiting for people
- [Proposals](docs/proposals.md): what agents may ask the engine to do
- [Running locally](docs/local.md): the CLI, instances, GitHub App and studio
- [Hub files](docs/reference.md): every field and default
- [Architecture](docs/architecture.md)

## Examples

| Hub | Repo or purpose |
| --- | --- |
| `examples/sandbox` | A small JavaScript package; the place to start |
| `examples/agentgraph` | agentgraph itself |
| `examples/clarinet` | A Rust workspace |
| `examples/sk` | A Acme App twin |
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
node bin/lsp.ts refs src/disk.ts:396:14
node bin/lsp.ts rename src/disk.ts:396:14 roomLeft --dry   # print the edits, change nothing
node bin/lsp.ts rename-symbol inventory listItems          # find the declaration by name; fails if the name is ambiguous
```

## License

MIT, see [LICENSE](LICENSE).
