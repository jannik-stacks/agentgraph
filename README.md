# agentgraph

agentgraph runs agent workflows on repository issues. Markdown graphs define agents, checks and steps; runners execute commands. Start with the [starter example](examples/starter).

## Quickstart

See [installation requirements](docs/local.md) and [Models](docs/local.md#models) for setup and login.

Inside your repository, install and copy the starter:

```sh
npm install -g @jannik-stacks/agi
cp -R "$(npm root -g)/@jannik-stacks/agi/examples/starter" .agentgraph
agi start "Fix padStart for len 0"
agi show 1
git diff main...agentgraph/1
agi review 1 changes "also test negative len"
agi merge 1
git merge --ff-only agentgraph/1
```

The starter implements, tests and reviews the change, then waits for you to merge it.

Before starting, read and edit the copied graph for your repository. See [First run](docs/local.md#first-run).

### From source

See [Local](docs/local.md) for source installation and `agi studio` requirements.

## Docs

[Start here](docs/index.md) for installation, graph files, checks, workflows and hosting.

## Examples

[Starter](examples/starter), [sandbox](examples/sandbox), [agentgraph](examples/agentgraph), [Bench graph](examples/bench), [dashboard](examples/dashboard) and [Bench plugin](examples/plugins/bench).

Tune is an experimental clone-only tool for proposing graph changes through Bench, with little test coverage and unstable commands and files. Submit a candidate with `node bin/tune.ts propose <tune dir> --from <graph dir> --why <text>`.

## Development

`npm run check` runs everything CI runs. See [Engine and code](docs/patterns.md) and [STYLE.md](STYLE.md).

## License

MIT, see [LICENSE](LICENSE).
