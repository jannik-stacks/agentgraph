# GitHub App for bothub

bothub acts on GitHub as one App. Every step and bot uses it; the step and bot show in the commit
message and under each comment. Commits go through the Git data API, so GitHub signs them and they
show as Verified, which a "require signed commits" rule needs.

The App is private, has no webhook, and asks for four repository permissions: contents write, pull
requests write, issues write, metadata read. It never gets workflows or administration.

## Settings

bothub reads the App from the environment, so the same settings work on a laptop, in a container
and in Kubernetes:

| Variable | What |
|---|---|
| `BOTHUB_APP_ID` | the App id |
| `BOTHUB_APP_SLUG` | the App slug; `@<slug>` in a comment works like `/bothub` |
| `BOTHUB_APP_KEY_FILE` | path to the private key (PEM, as GitHub hands it out) |
| `BOTHUB_INSTALLATION_ID` | the installation on the repository |

Locally they go in `~/.bothub/.env` (or `$BOTHUB_DATA/.env`) or the shell. In Kubernetes, put the
key in a Secret mounted as a file into the runner only, and set the variables on the runner:

```sh
kubectl -n bothub create secret generic bothub-app \
  --from-file=key.pem=$HOME/.config/bothub/<slug>/key.pem
```

Keys never live in a repository and never appear in logs.

## Create the App

```sh
bothub setup-app                      # the App belongs to your account
bothub setup-app --org acme       # the App belongs to the organization
```

1. The command prints `http://127.0.0.1:5189/`; open it in the browser where you are signed in. The
   page sends the manifest to GitHub.
2. On GitHub, click **Create GitHub App**. For `--org`, you must be an owner of the organization or
   one of its GitHub App managers.
3. GitHub sends you back; the command saves `~/.config/bothub/<slug>/key.pem` and `app.env`, both
   readable only by you, and forwards you to the install page.
4. On the install page, pick **Only select repositories**, choose the one repository, click
   **Install**. The command adds `BOTHUB_INSTALLATION_ID` to `app.env` and exits.

Who must approve the install:

| App owner | Repository owner | Install |
|---|---|---|
| your account | your account | you install it |
| the organization | the organization | an organization owner installs it, or anyone with admin on the repository can request it |
| your account | an organization | a repository admin can only request it; an organization owner approves under the organization's settings, GitHub Apps, pending requests |

When the install was only requested, the command says so and exits; once an owner approves, the
installation id is the number at the end of the installation's settings URL. Add it to `app.env`.

Then copy the lines of `app.env` into `~/.bothub/.env`.

## Webhooks later

Runs are started by hand for now, with no webhook and no tunnel. When webhooks are wanted, expose only the webhook path through a Cloudflare tunnel.
