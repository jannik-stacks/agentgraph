# Running on GitHub

The GitHub App polls without webhooks. See [Workflows](workflows.md#what-starts-a-run) for triggers and [trust](workflows.md#trust-and-scope). <!-- code: src/workflow.ts#isIssueTriggered src/run/trigger.ts#tick -->

## Create the App

From an agentgraph checkout:

```sh
node bin/setup-app.ts
node bin/setup-app.ts --org acme
```

Open the printed URL, create the App, then install it on your repositories. Credentials go in `~/.config/agentgraph/<slug>/app.env`. Use `--name` to override the App name, `--dir` the credentials folder and `--port` the setup port. <!-- code: bin/setup-app.ts#setupApp -->

The App requests write access to contents, pull requests and issues, and read access to metadata, checks and statuses. It requests no workflows or administration access. <!-- code: bin/setup-app.ts#makeGithubAppSetupManifest -->

## The key

Setup stores the private key in the macOS login Keychain or a private `key.pem` beside `app.env`. The wrapper passes Keychain keys through `/dev/fd/3`:

```sh
npm run with-key -- <slug> loop --instance live --data ~/agentgraph-data
npm run keychain-import -- <slug>
```

`keychain-import` moves `key.pem` into the Keychain. On other hosts, set `AGENTGRAPH_APP_ID` and `AGENTGRAPH_APP_KEY_FILE`, or point `AGENTGRAPH_APP_ENV` at `app.env`. <!-- code: bin/setup-app.ts#saveKeyInKeychain src/main.ts#readEngineEnv -->

## Project boards

[Column triggers](workflows.md#project-boards) need a user token with `read:project`. The engine reads `AGENTGRAPH_PROJECT_TOKEN`, then falls back to `gh auth token`.

```sh
gh auth refresh -s read:project
```

[Board writes](plugins.md#status-hooks) need `project` scope instead. <!-- code: src/github.ts#readProjectToken -->

## Work from a fork

To work on a repository the App cannot be installed on, install the App on your fork only. Set `AGENTGRAPH_FORK` beside `AGENTGRAPH_REPO`, both as `owner/name`:

```sh
AGENTGRAPH_REPO=acme/mono AGENTGRAPH_FORK=me/mono agi loop --tracker github
```

The engine reads issues, comments and pull requests in `AGENTGRAPH_REPO` with your user token, the one [project boards](#project-boards) use: `AGENTGRAPH_PROJECT_TOKEN`, then `gh auth token`. Sign in with `gh auth login` as an account that can open pull requests upstream. A classic personal access token needs `public_repo` scope, or `repo` for a private upstream. `gh` keeps one login per machine, so instances with different accounts each set the token in their env file. <!-- code: src/github.ts#github src/github.ts#readProjectToken -->

The engine pushes `agentgraph/` branches to the fork as the App and opens each pull request upstream from the fork's branch. A pull request that is already open for that branch and base gets its title and body updated. Checkouts fetch base branches and tags from upstream and only `agentgraph/` branches from the fork. `agi show` checks the App installation on the fork. Restart the loop after changing the fork. <!-- code: src/github.ts#githubTracker src/mirror.ts#makeSandbox bin/run.ts#runOnInstance -->

Upstream gets pull requests and nothing else. Comments, questions, reactions and labels are not sent, and their trace line says so. A question still waits: read it in `agi show` or the studio and answer with a comment upstream. Merges and new issues are refused, and status labels and headers are not written. <!-- code: src/github.ts#githubTracker -->

Your own pull requests and comments read as the agent's own text. Without `AGENTGRAPH_TRUST` your comments are trusted; with it, the list decides. Everyone else still needs write access upstream for [trust](workflows.md#trust-and-scope), and a person whose permission your token may not read stays untrusted. A stacked pull request needs its base branch upstream, so leave `stacks` off. <!-- code: src/github.ts#githubTracker -->

## Start the engine

Configure a [named instance](local.md#named-instances-and-settings) with a checkout, graph and `tracker: github`. Put App and [model settings](sandbox.md#models) in its env file. <!-- code: src/instance.ts#readInstance src/instance.ts#ensureGraph -->

```sh
agi loop --instance live --data ~/agentgraph-data
agi show --instance live --data ~/agentgraph-data
```

`show` warns when the App reaches other repositories. See [Hosting](hosting.md) for deployment. <!-- code: src/github.ts#readInstallationReach -->
