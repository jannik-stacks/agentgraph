# agentgraph

agentgraph runs agent workflows on repository issues. A graph of Markdown files defines the agents, checks and steps; a runner executes their commands. The [starter example](examples/starter) uses Docker, checks changes and waits for a human merge.

## Quickstart

You need Node 24, Docker without root and `git config user.name`. No API key: when you are logged in to Claude Code, the first `agi start` runs `claude setup-token`, tests the pasted token and keeps it in the macOS Keychain (a 0600 file on Linux). A ChatGPT login through Codex, an Anthropic key or LiteLLM also work; see [Models](docs/local.md#models).

In a repo with an off-by-one bug in `padStart` and a failing test, copy the starter example once, then start an issue:

```sh
npm install -g @jannik-stacks/agi
cp -R "$(npm root -g)/@jannik-stacks/agi/examples/starter" .agentgraph
agi start "padStart is off by one when len is 0"
agi show 1
git diff main...agentgraph/1
agi review 1 changes "also cover a negative len"
agi merge 1
git merge --ff-only agentgraph/1
agi studio
```

The starter implements, tests and reviews the change, then waits for you. Its branch lands in your repo without moving your checkout.

The engine requires a graph. Read and edit the copied agents, workflows and checks for your repo before the first run. [First run](docs/local.md#first-run) also covers copying from a clone. No GitHub needed: `~/.agentgraph/<repo>/` holds `instance.yaml`, the runs in `data/` and `tracker/`, which stands in for GitHub.

### From source

`agi studio` needs a clone: run `npm ci && npm run build && npm link` in it, and `npm run build` again after each pull.

## Docs

[Start here](docs/index.md) for installation, graph files, checks, workflows and hosting.

## Examples

| Example                  | What it is                                         |
| ------------------------ | -------------------------------------------------- |
| `examples/starter`       | Copy this graph to start with your own repo        |
| `examples/sandbox`       | A small JavaScript package; the place to start     |
| `examples/agentgraph`    | The graph agentgraph runs on itself                |
| `examples/bench`         | The graph the bench replays pull requests with     |
| `examples/dashboard`     | A studio page plugin for runs and tracker activity |
| `examples/plugins/bench` | An example studio plugin for Bench comparisons     |
| `examples/conflicts`     | Conflicts resolved in a run of their own           |

Tune is an experimental clone-only tool for proposing graph changes through Bench, with little test coverage and unstable commands and files. Submit a candidate with `node bin/tune.ts propose <tune dir> --from <graph dir> --why <text>`.

## Development

`npm run check` runs everything CI runs. See [Engine and code](docs/patterns.md) and [STYLE.md](STYLE.md).

## License

MIT, see [LICENSE](LICENSE).
