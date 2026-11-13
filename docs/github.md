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

## Start the engine

Configure a [named instance](local.md#named-instances-and-settings) with a checkout, graph and `tracker: github`. Put App and [model settings](sandbox.md#models) in its env file. <!-- code: src/instance.ts#readInstance src/instance.ts#ensureGraph -->

```sh
agi loop --instance live --data ~/agentgraph-data
agi show --instance live --data ~/agentgraph-data
```

`show` warns when the App reaches other repositories. See [Hosting](hosting.md) for deployment. <!-- code: src/github.ts#readInstallationReach -->
