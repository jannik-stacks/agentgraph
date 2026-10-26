# GitHub App for agentgraph

agentgraph acts on GitHub as one App. Every step and bot uses it; the step and bot show in the commit
message and under each comment. Commits go through the Git data API, so GitHub signs them and they
show as Verified, which a "require signed commits" rule needs.

The App is private, has no webhook, and asks for four repository permissions: contents write, pull
requests write, issues write, metadata read. It never gets workflows or administration.

## Settings

agentgraph reads the App from the environment, so the same settings work on a laptop, in a container
and in Kubernetes:

| Variable | What |
|---|---|
| `AGENTGRAPH_APP_ID` | the App id |
| `AGENTGRAPH_APP_KEY_FILE` | path to the private key (PEM, as GitHub hands it out) |

Locally they go in the env file `AGENTGRAPH_APP_ENV` names, or the shell. In Kubernetes, put the
key in a Secret mounted as a file into the runner only, and set the variables on the runner:

```sh
kubectl -n agentgraph create secret generic agentgraph-app \
  --from-file=key.pem=$HOME/.config/agentgraph/<slug>/key.pem
```

Keys never live in a repository and never appear in logs.

## Create the App

```sh
node bin/setup-app.ts                    # the App belongs to your account
node bin/setup-app.ts --org acme     # the App belongs to the organization
```

1. The command prints `http://127.0.0.1:5189/`; open it in the browser where you are signed in. The
   page sends the manifest to GitHub.
2. On GitHub, click **Create GitHub App**. For `--org`, you must be an owner of the organization or
   one of its GitHub App managers.
3. GitHub sends you back and the command forwards you to the install page. It saves `app.env` in
   `~/.config/agentgraph/<slug>/`, readable only by you. On macOS the private key goes into the login
   Keychain, which asks before every read; elsewhere, or when the Keychain refuses, it goes into
   `key.pem` beside `app.env`, also readable only by you.
4. On the install page, pick **Only select repositories**, choose the one repository, click
   **Install**. agentgraph finds the installation from the repo, so `app.env` needs nothing more.

Who must approve the install:

| App owner | Repository owner | Install |
|---|---|---|
| your account | your account | you install it |
| the organization | the organization | an organization owner installs it, or anyone with admin on the repository can request it |
| your account | an organization | a repository admin can only request it; an organization owner approves under the organization's settings, GitHub Apps, pending requests |

When the install was only requested, agentgraph works once an owner approves it.

Then point `AGENTGRAPH_APP_ENV` at the `app.env` the command printed. With the key in the Keychain,
`app.env` names `/dev/fd/3`. `with-key` reads the key from the Keychain onto that descriptor and passes
the other arguments to `bin/run.ts`:

```sh
npm run with-key -- <slug> loop --hub examples/sandbox --data ~/agentgraph-data
```

An App set up before the Keychain has a `key.pem`. `keychain-import` moves it into the Keychain, points
`app.env` at `/dev/fd/3` and deletes the file:

```sh
npm run keychain-import -- <slug>
```

## Mention autocomplete

People talk to the bot by mentioning it, `@<slug>`, but GitHub only autocompletes logins that can be
mentioned in the repository, and an App has no such login. To get autocomplete, create an ordinary
GitHub user whose login is the App's slug (for example `stx-agentgraph`) and add it to the repository as
a collaborator with read access. It never needs a token or a password the engine knows; the App
keeps doing all the writes. In an organization the user takes a seat. Without it everything still
works: the engine reads a typed `@<slug>` or `/agentgraph` the same way.

## Webhooks later

Runs are started by hand for now, with no webhook and no tunnel.
