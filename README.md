# agentgraph

agentgraph runs coding agents on your repo's issues. You describe the agents, checks and workflows in `.agentgraph/`, a folder of Markdown files. A `/agent` comment or a label starts a workflow. Agents work in Docker sandboxes and never hold a GitHub token. The engine pushes their work only after the checks pass, and a person merges it. The studio shows every run.

## Quickstart

You need Node 24, Docker, and a Claude login, an Anthropic key, or [the local model stack](infra/local/README.md). Inside any git repo:

```sh
npm install -g @jannik-stacks/agi
agi start "Add a greet function"
agi show                                   # what needs you
agi review 1 changes "also greet by name"  # drives it again
agi merge 1                                # then: git merge agentgraph/1
```

The first command makes a local instance of the repo under `~/.agentgraph`, with a folder that stands in for GitHub. Your checkout never moves; the work lands as the branch `agentgraph/1`. Without `.agentgraph/` it uses a default graph: implement, run the tests, review, wait for you.

## Docs

Start at [What agentgraph is](docs/index.md), then:

1. [Install and first run](docs/local.md)
2. [The graph folder](docs/reference.md)
3. [Checks and results](docs/checks.md)
4. [Workflows](docs/workflows.md)
5. [Running on GitHub](docs/github.md)
6. [Hosting](docs/hosting.md)

The [CLI](docs/cli.md) page lists every verb, flag and setting.

## Examples

| Example | What it is |
| --- | --- |
| `examples/sandbox` | A small JavaScript package; the place to start |
| `examples/agentgraph` | The graph agentgraph runs on itself |
| `examples/bench` | The graph the bench replays pull requests with |

## Development

`npm run check` runs everything CI runs. See [Engine and code](docs/patterns.md) and [STYLE.md](STYLE.md).

## License

MIT, see [LICENSE](LICENSE).
