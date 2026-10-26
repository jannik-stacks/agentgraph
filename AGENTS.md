# agentgraph

Read [STYLE.md](STYLE.md) and [docs/patterns.md](docs/patterns.md) before writing code.
`npm run check` must pass before a commit.

## Code style

The full rules are in [STYLE.md](STYLE.md). The ones that matter most:

- **Check the exceptions every loop.** Before finishing a change, reread [STYLE.md#exceptions](STYLE.md#exceptions)
  and say whether a restructure or rename would remove one. A new exception needs a reason in that list.
- **Derive types, never copy them.** Use `Pick`, `Omit`, `Partial`, indexed access or `typeof X.Type` at the use site:
  `type Made = { mounts: Mount[] } & Pick<Graph, 'image' | 'network'>`. ([rule 1](STYLE.md#types))
- **Search before adding a function.** `rg` the verb and the noun, check Node and Effect built-ins, and reuse what
  exists. ([rule 26](STYLE.md#simplicity-and-reuse))
- **Names lint does not check:** `is` for predicates and `why` for reasons (`isAgentBranch`, `whyUnpushable`); types
  are a qualifier plus a spelled-out noun (`SandboxSetup`, not `Item`); `src/` uses short words, edge code long ones
  (`readArmUsageOverAttempts`); file fields stay short (`judge`), types may qualify them (`CheckJudge`).
  ([rules 8 to 15](STYLE.md#naming))
- **No code comments.** The one exception is `// UNEXPECTED: <what and why>`. ([rule 18](STYLE.md#comments-and-docs-links))

[STYLE.md#lint-and-enforcement](STYLE.md#lint-and-enforcement) lists what tools enforce. After a rename, run
`node bin/style.mjs --write`.

## Working on this repo

The agentgraph bot, humans and Claude Code meet one bar here: the rules above, the checks of the
[agentgraph example](examples/agentgraph/README.md), and small linear commits with conventional one-line subjects.
`npm run hooks` installs the hooks that enforce it.

- The bot works on one `agentgraph/<n>` branch per issue and opens a pull request from it. It never pushes `main`.
- Before you work, rebase your unpushed commits onto `origin/main`: `git fetch origin && git rebase origin/main`.
- Pull requests merge by rebase only, so `main` stays linear.
- The repo is public. Commits, pull requests and comments name no home folder, no email but a noreply one, and
  nothing on the operator's deny list; the example's hygiene check blocks them. Point `AGENTGRAPH_DENY` at the list,
  or put it at `examples/agentgraph/deny.txt`, which git ignores.

## Releasing

The package is `@jannik-stacks/agi` on npm. `npm run build` bundles the CLI into `dist/`, and `npm pack --dry-run`
lists what ships. The studio is not in the package; `agi studio` needs a clone.

- A user-facing change comes with a changeset: run `npx changeset`, pick patch, minor or major, write one or two
  plain lines, and commit the file in `.changeset/` with the change. Don't edit `CHANGELOG.md` by hand.
- Stay on 0.0.x for now: every changeset is a patch, even a breaking one. On 0.x, changesets turns a major bump
  into 1.0.0 and a minor bump into 0.1.0.
- On each push to `main`, [the release workflow](.github/workflows/release.yml) opens or updates the Version
  Packages pull request, which sets the version and writes the changelog. Merging it publishes to npm through
  trusted publishing, with provenance and no token.

The workflow only runs on pushes to `main` of this repo, never on pull requests, so a pull request from a fork
can't reach the token or npm. The publish job runs in the `npm` environment, which only `main` may deploy to.

Trusted publishing needs the package on npm, so 0.0.1 went out by hand from `main`, before the push that added
the workflow: `npm ci && npm run build && npm publish --access public`, then tag `v0.0.1`. One-time setup after
that:

- GitHub, Settings, Environments: create `npm` and limit deployment branches to `main`. Add yourself as a required
  reviewer to approve each publish.
- npmjs.com, the package's Settings, Trusted publishing: add a GitHub Actions publisher with owner
  `jannik-stacks`, repository `agentgraph`, workflow `release.yml` and environment `npm`. Then set publishing
  access to require two-factor authentication and disallow tokens.
- GitHub, Settings, Actions, General: allow GitHub Actions to create pull requests, so it can open the Version
  Packages pull request.
