# Without GitHub

A forge folder stands in for GitHub, and an instance bundles one with a hub copy and data for one repo. Both need no App, but sessions still need Docker and [the model stack](local.md#the-model-stack).

## The forge folder

A forge folder holds `<n>.md` issues, `<n>.jsonl` timelines, `<n>/pull.json` and `diff.patch` for pull requests, and a bare `origin.git`. Unlike GitHub, a forge folder refuses a whole push that touches `.github/`, and a second `pull_request` for a branch leaves the open one as it is. <!-- code: src/forge.ts#fileForge src/status.ts#needsYou -->

```sh
node bin/forge.ts ~/forge init ../path/to/repo
node bin/forge.ts ~/forge issue "Reject a negative count" --body issue.md
node bin/forge.ts ~/forge comment 1 /agent
npx agentgraph --forge ~/forge --hub examples/sandbox --all --data ~/agentgraph-data
```

| Forge command | Effect |
| --- | --- |
| `show [n]` | Every issue and pull request, or one timeline and diff |
| `comment <n> <text> [--line <path>:<line>]` | Comment on an issue, a pull request or a line |
| `issue ... --label <name>`, `label <n> <name>` | Add a label, which can start a workflow |
| `review <n> changes <text>`, `review <n> approve [text]` | Request changes or approve; earlier line comments join the review |
| `merge <n>` | Fast-forward the base, retarget stacked pull requests and close the issue the branch names; fails if the base moved |
| `close <n>` | Close an issue |
| `init <repo> --at <sha>` | Copy only that commit and its history as `main`, hiding later fixes |

Actions run as `--as <name>`, the instance owner or `git config user.name`, and count as a maintainer's.

## Instances

An instance bundles a hub copy, a forge, data and optional keys for one repo. Your repo stays untouched until you `export`. Both CLIs find the instance around the working directory when no hub, forge or data flag is given. <!-- code: src/instance.ts#instanceAt -->

```
~/agentgraph/kit/
  instance.yaml   repo, base and owner, see Hub files
  hub/            editable hub copy
  forge/          issues, timelines, origin.git
  data/           runs, traces, mirror
  keys.env        optional KEY=value settings
```

## Set one up

```sh
node bin/forge.ts ~/agentgraph/kit init ~/code/acme-app --hub examples/sandbox --base main
```

`examples/sandbox` is written for its own small JavaScript package: its checks run `npm test` and its prompts name its files. For another repo, edit the hub copy in `hub/` first: `setup`, the checks and the skills. `check --hub ~/agentgraph/kit/hub` validates it.

Then turn the proxy keys into `keys.env`. Its values apply only where the environment has none.

```sh
sed -n 's/^AGENTGRAPH_LLM_API_KEY_\([A-Z0-9_]*\)=\(.*\)$/\1=\2/p' infra/local/.keys.env |
  awk '{ i = index($0, "="); n = tolower(substr($0, 1, i - 1)); gsub("_", "-", n); printf "%s%s=%s", sep, n, substr($0, i + 1); sep = "," }' |
  sed 's/^/AGENTGRAPH_PROXY_KEYS=/' > ~/agentgraph/kit/keys.env
```

## A loop by hand

```sh
node bin/forge.ts ~/agentgraph/kit issue "Reject a negative count" --body issue.md --label agent:ready
npx agentgraph --instance ~/agentgraph/kit --all
node bin/forge.ts ~/agentgraph/kit show 2
node bin/forge.ts ~/agentgraph/kit review 2 changes "also cover zero"
npx agentgraph --instance ~/agentgraph/kit --all
node bin/forge.ts ~/agentgraph/kit review 2 approve
node bin/forge.ts ~/agentgraph/kit merge 2
node bin/forge.ts ~/agentgraph/kit export 2
```

Answer questions with `/agent` comments, as [Waiting](loop.md#waiting) describes.

`export <n>` fetches the branch into your repo without moving its checked-out branch or overwriting work. `export <n> --patch <file>` writes the missing commits as a patch instead. `sync` fast-forwards the instance base from your repo; if both moved, export and merge in your repo first.

Several instances run side by side, each with its own mirror and data:

```sh
npx agentgraph loop --instance ~/agentgraph/kit &
npx agentgraph loop --instance ~/agentgraph/clarinet &
```
