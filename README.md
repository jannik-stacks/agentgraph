# agentgraph

agentgraph runs coding agents on your repo's issues. The agents, checks and workflows are Markdown files in `.agentgraph/`. Agents work in Docker sandboxes without a GitHub token, the engine pushes only checked work, and a person merges it.

## Quickstart

You need Node 24, Docker without root and `git config user.name`. No API key: when you are logged in to Claude Code, the first `agi start` runs `claude setup-token`, tests the pasted token and keeps it in the macOS Keychain (a 0600 file on Linux). An Anthropic key or LiteLLM also work; see [Models](docs/local.md#models).

In a repo with an off-by-one bug in `padStart` and a failing test:

```sh
npm install -g @jannik-stacks/agi
agi start "padStart is off by one when len is 0"
agi show 1
git diff main...agentgraph/1
agi review 1 changes "also cover a negative len"
agi merge 1
git merge --ff-only agentgraph/1
agi studio
```

The first run builds the sandbox images, about 3 minutes. An implementor changes the code and runs the tests, a reviewer reads it, then it waits for you. The branch lands in your repo; your checkout never moves.

Without `.agentgraph/` it runs the [default graph](default/workflows/issue.md). No GitHub needed: `~/.agentgraph/<repo>-<hash>-local/` holds `instance.yaml`, the runs in `data/` and `forge/`, which stands in for GitHub.

### From source

`agi studio` needs a clone: run `npm ci && npm run build && npm link` in it, and `npm run build` again after each pull.

## Docs

Start at [What agentgraph is](docs/index.md), then:

1. [Install and first run](docs/local.md)
2. [The graph folder](docs/reference.md)
3. [Checks and results](docs/checks.md)
4. [Workflows](docs/workflows.md)
5. [Running on GitHub](docs/github.md)
6. [Hosting](docs/hosting.md)
7. [CLI](docs/cli.md)

## Examples

| Example               | What it is                                     |
| --------------------- | ---------------------------------------------- |
| `examples/sandbox`    | A small JavaScript package; the place to start |
| `examples/agentgraph` | The graph agentgraph runs on itself            |
| `examples/bench`      | The graph the bench replays pull requests with |

## Development

`npm run check` runs everything CI runs. See [Engine and code](docs/patterns.md) and [STYLE.md](STYLE.md).

## License

MIT, see [LICENSE](LICENSE).
