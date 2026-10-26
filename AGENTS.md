# agentgraph

Read [STYLE.md](STYLE.md) and [docs/patterns.md](docs/patterns.md) before writing code.
`npm run check` must pass before a commit.

## Code style

The full rules are in [STYLE.md](STYLE.md). The ones that matter most:

- **Check the exceptions every loop.** Before finishing any change, reread
  [STYLE.md#exceptions](STYLE.md#exceptions) and say whether a restructure or rename would remove one.
  A new exception needs a reason in that list.

- **Derive types, never copy them.** Use `Pick`, `Omit`, `Partial`, indexed access or `typeof X.Type` at
  the use site.
  Before: `type Made = { mounts: Mount[]; image: string; network?: string }`.
  After: `type Made = { mounts: Mount[] } & Pick<Graph, 'image' | 'network'>`. ([rule 1](STYLE.md#types))
- **Search before adding a function.** `rg` the verb and the noun, check Node and Effect built-ins, and
  reuse what exists. ([rule 26](STYLE.md#simplicity-and-reuse))
- **Names lint does not check:** predicates start with `is`, reason functions with `why`
  (`isAgentBranch`, `whyUnpushable`); types are a qualifier plus a spelled-out noun (`SandboxSetup`, not
  `Item` or `RepoSetup`); `src/` uses short vocabulary words, edge code long self-explaining ones
  (`readArmUsageOverAttempts`); workflow and check file fields stay short (`judge`), types may qualify them
  (`CheckJudge`). ([rules 8 to 15](STYLE.md#naming))
- **No code comments.** The one exception is `// UNEXPECTED: <what and why>` for something the code cannot
  say. ([rule 18](STYLE.md#comments-and-docs-links))

What lint and the agentgraph example's checks enforce, and the baseline for old violations, is
[STYLE.md#lint-and-enforcement](STYLE.md#lint-and-enforcement). After a rename, run `node bin/style.mjs --write`.

## Working on this repo

The agentgraph bot works here beside humans and Claude Code, and all three meet one bar: the rules above, the
checks of the [agentgraph example](examples/agentgraph/README.md), and small linear commits with conventional one-line
subjects. `npm run hooks` installs the hooks that hold your commits to it.

- The bot works on `agentgraph/<n>` branches, one per issue, and opens a pull request from each. It never pushes
  `main`.
- Before you work, fetch and rebase your unpushed commits onto `origin/main`: `git fetch origin && git rebase origin/main`.
- Pull requests merge by rebase only, so `main` stays linear.
- The repo is public. Commits, pull requests and comments name no home folder, no email other than a noreply one, and
  nothing on the operator's deny list; the hygiene check of the agentgraph example blocks them. Point `AGENTGRAPH_DENY` at the list, or
  put it at `examples/agentgraph/deny.txt`, which git ignores.
