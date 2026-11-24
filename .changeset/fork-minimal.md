---
'@jannik-stacks/agi': patch
---

The GitHub tracker can work from a fork: set `AGENTGRAPH_FORK` beside `AGENTGRAPH_REPO` to read issues upstream with your user token, push `agentgraph/` branches to the fork and open pull requests upstream. A tracker plugin's host now carries `config`, the provider it reads its own variables from, and its `origin` is tagged: `{ kind: 'folder', dir }` or `{ kind: 'remote', upstream, branches }`. Loop scans on a remote tracker now keep the 30 second quiet period. A permission GitHub hides (403) leaves a person untrusted instead of failing the event read, and an existing pull request is updated only when its head and base match.
