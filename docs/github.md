# Running on GitHub

The GitHub tracker uses a GitHub App and polls the repo; it needs no webhook. Workflows select comment, label or project-column triggers. [Commands](workflows.md#commands) and instance trust control who can steer runs. <!-- code: src/workflow.ts#isIssueTriggered src/run/trigger.ts#tick -->

## Create the App

From an agentgraph checkout:

```sh
node bin/setup-app.ts
node bin/setup-app.ts --org acme
```

Open the printed URL, create the App, then install it on the repositories it should serve. The command saves `app.env` under `~/.config/agentgraph/<slug>/`. `--name`, `--dir` and `--port` override the App name, credentials folder and setup port. <!-- code: bin/setup-app.ts#setupApp -->

The setup requests contents, pull requests and issues write access, plus metadata, checks and statuses read access. It requests no workflows or administration permission. GitHub signs commits written through the Git API. <!-- code: bin/setup-app.ts#makeGithubAppSetupManifest src/github.ts#githubTracker -->

## How it talks to GitHub

The tracker caches scoped tokens and conditional reads across passes. Rate limits delay requests until GitHub allows a retry. Plugin tools can use `searchIssues` to search this repo under the same text trust rules. <!-- code: src/run/trigger.ts#scanIssuesAndRunningRuns src/services.ts#makeProductionLayers src/github.ts#requester src/github.ts#github src/tracker.ts#Tracker src/tracker.ts#parseIssueSearch src/tracker.ts#folderTracker src/github.ts#githubTracker -->

## The key

Setup stores the private key in the macOS login Keychain, or in a private `key.pem` beside `app.env`. The Keychain wrapper passes it through `/dev/fd/3`:

```sh
npm run with-key -- <slug> loop --instance live --data ~/agentgraph-data
npm run keychain-import -- <slug>
```

`keychain-import` moves a saved `key.pem` into the Keychain. On other hosts, set `AGENTGRAPH_APP_ID` and `AGENTGRAPH_APP_KEY_FILE`, or point `AGENTGRAPH_APP_ENV` at `app.env`. <!-- code: bin/setup-app.ts#saveKeyInKeychain src/main.ts#readEngineEnv -->

## Project boards

Column triggers need a user token with `read:project`. The engine reads `AGENTGRAPH_PROJECT_TOKEN`, then falls back to `gh auth token`:

```sh
gh auth refresh -s read:project
```

The [board plugin](workflows.md#project-boards) also writes card fields and needs `project` scope instead. <!-- code: src/github.ts#readProjectToken -->

## Start the engine

Select a [named instance](local.md#named-instances-and-settings) with a checkout, graph and `tracker: github`. Put App and [model settings](sandbox.md#models) in its env file, then run:

```sh
agi loop --instance live --data ~/agentgraph-data
agi show --instance live --data ~/agentgraph-data
```

The loop reads the selected graph; it imposes no implement, review or merge sequence. `show` warns when the App can reach other repos. See [Hosting](hosting.md) for service deployment examples. <!-- code: src/instance.ts#readInstance src/instance.ts#ensureGraph src/github.ts#readInstallationReach -->
