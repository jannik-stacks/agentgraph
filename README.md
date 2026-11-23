# agentgraph

agentgraph runs agent workflows on repository issues. A graph defines the agents, checks and steps. The engine runs those steps and applies the actions they propose. <!-- code: src/folder.ts#Graph src/run/drive.ts#runWorkflow src/run/settle.ts#writeProposals -->

## Quickstart

[Install agentgraph, choose a model and copy the starter graph](docs/local.md). Review the graph in your repository, then try a small change. <!-- code: examples/starter/workflows/issue.md -->

```sh
agi start "Fix padStart for len 0"
agi show 1
git diff main...agentgraph/1
agi review 1 changes "also test negative len"
agi merge 1
git merge --ff-only agentgraph/1
```

The starter tests and reviews the change, then waits for you to merge it. <!-- code: examples/starter/workflows/issue.md examples/starter/checks/tests.md -->

## Docs

[Start here](docs/index.md) for installation, graph files, checks, workflows and hosting.

## Examples

[Starter](examples/starter), [sandbox](examples/sandbox), [agentgraph](examples/agentgraph), [Bench graph](examples/bench), [dashboard](examples/dashboard) and [Bench plugin](examples/plugins/bench).

See [Tune](docs/bench.md#tune) for experiments that propose graph changes.

## Development

Use the [maintainer guides](docs/index.md#maintainers) to follow a run through the engine, find the files to change and test your work.

## License

MIT, see [LICENSE](LICENSE).
