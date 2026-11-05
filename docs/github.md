# Running on GitHub

On GitHub, agentgraph acts as one GitHub App. The runner polls the repo, so the App needs no webhook or tunnel. People start work with `/agent` or `@agent` in a comment, with a trigger label, or by moving an issue's card into a project board column; see [Workflows](workflows.md#what-starts-a-run). Commands such as `/agent:stop` are separate from text, and `commands` in `settings.yaml` limits who may use them; see [Commands](workflows.md#commands).

The App is private and asks for four repository permissions: contents write, pull requests write, issues write and metadata read. It never gets workflows or administration. Commits go through the Git API, so GitHub signs them and a "require signed commits" rule passes.

## Create the App

From a checkout of agentgraph:

```sh
node bin/setup-app.ts                # the App belongs to your account
node bin/setup-app.ts --org acme     # the App belongs to the organization
```

1. Open the `http://127.0.0.1:5189/` it prints, in the browser where you are signed in to GitHub.
2. Click **Create GitHub App**. For `--org` you must be an owner or a GitHub App manager of the organization.
3. GitHub sends you to the install page. The command saves `app.env` in `~/.config/agentgraph/<slug>/`, readable only by you.
4. Pick **Only select repositories**, choose the repo and click **Install**. The runner finds the installation from the repo.

Who must approve the install:

| App owner | Repo owner | Install |
| --- | --- | --- |
| your account | your account | you install it |
| the organization | the organization | an organization owner installs it, or a repo admin requests it |
| your account | an organization | a repo admin requests it, and an organization owner approves it under the organization's GitHub Apps settings |

Each loop pass shares one open-issue listing and shared event polls across issue ticks. Issues with no prior run share a separate history poll, so their catch-up keeps live runs first. The process keeps scoped installation tokens, ETags and write permissions per App and repo, so they last across passes, refreshed session credentials and rebuilt tracker setups. Conditional requests reuse an ETag only with the token and API version that received it. Whether a login may write is asked once per ten minutes. A rate-limit response holds every request, the limited one included, until GitHub's reset time or retry delay, and logs one warning. <!-- code: src/run/trigger.ts#scanIssuesAndRunningRuns src/services.ts#makeProductionLayers src/github.ts#requester src/github.ts#github -->

The tracker offers `searchIssues(query, { state, limit })` to read this repo's issues through the same requester and text trust rules. Queries take keywords up to 256 characters; search qualifiers, operators and punctuation are stripped. Repository and issue scope stay fixed, and returned repository identities are checked. `state` defaults to `open` and also accepts `closed` or `all`; `limit` defaults to 20 and accepts integers from 1 to 100. The folder tracker matches the keywords in issue titles and bodies for local tests. <!-- code: src/tracker.ts#Tracker src/tracker.ts#parseIssueSearch src/tracker.ts#folderTracker src/github.ts#githubTracker -->

## The key

On macOS the private key goes into the login Keychain, which asks before every read, and `app.env` names `/dev/fd/3`. Elsewhere, or when the Keychain refuses, it goes into `key.pem` beside `app.env`, readable only by you. Keys never go in a repo or a log.

`with-key` reads the key from the Keychain onto that descriptor and passes the other arguments to `bin/run.ts`. `keychain-import` moves an older `key.pem` into the Keychain and deletes the file.

```sh
npm run with-key -- <slug> loop --tracker github --dir examples/sandbox --data ~/agentgraph-data
npm run keychain-import -- <slug>
```

On other hosts, set `AGENTGRAPH_APP_ID` and `AGENTGRAPH_APP_KEY_FILE`, or point `AGENTGRAPH_APP_ENV` at `app.env`. [Hosting](hosting.md) shows each host.

## Project boards

A workflow with a `column` trigger reads the repo's project boards with your own token, since a GitHub App cannot read a personal account's boards. Give the `gh` login the scope once:

```sh
gh auth refresh -s read:project
```

The runner then uses `gh auth token`. Where there is no `gh`, set `AGENTGRAPH_PROJECT_TOKEN` to a token with `read:project`. It is only read from the environment and never logged or stored. See [Project boards](workflows.md#project-boards).

The board plugin also writes card fields, which needs the `project` scope on the same token instead:

```sh
gh auth refresh -s project
```


## Start the runner

From a checkout of agentgraph, prepare a data folder with the agents' model keys, then start the loop:

```sh
infra/local/e2e.sh ~/agentgraph-data examples/sandbox
set -a; . ~/agentgraph-data/.env; set +a
AGENTGRAPH_REPO=owner/name agi loop --instance live --repo ~/code/project --tracker github --dir examples/sandbox --data ~/agentgraph-data
AGENTGRAPH_REPO=owner/name agi show --instance live --tracker github --dir examples/sandbox --data ~/agentgraph-data
```

`e2e.sh` writes the keys from the [local stack](../infra/local/README.md) as `AGENTGRAPH_PROXY_KEYS` to `.env` in the data folder and prints the commands to run. The runner does not load that file, so source it first. `loop` without `--dir` uses the repo's [own graph](reference.md#which-graph-runs) and `AGENTGRAPH_REPO`. `show` needs App credentials and warns when the App reaches other repos.
