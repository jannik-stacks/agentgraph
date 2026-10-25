# Running on Cloudflare

One Worker runs the engine and its sandboxes on Cloudflare Containers. You need a Cloudflare account with Containers, Node 22.18 or later and Docker for the image builds. Commands run from `agentgraph/`.

```sh
examples/deploy/cloudflare/up
```

`up` installs wrangler into the example folder, runs `wrangler login` when you are not logged in, creates the R2 bucket `agentgraph-data`, and asks for what is not deployed yet:

| Secret | What it is |
| --- | --- |
| `AGENTGRAPH_APP_ENV` | Path to the App's `app.env`; empty creates the App with `node bin/setup-app.ts` |
| `AGENTGRAPH_REPO` | `owner/name` of the repo the engine works on |
| `GATEWAY_URL` | Your OpenAI-compatible model gateway, with its `/v1` |
| `AGENTGRAPH_PROXY_KEYS` | One gateway key per agent, as in [Models](sandbox.md#models) |
| `GATEWAY_HEADERS` | Optional, read from the environment only; see below |

Values already in the environment are used without asking, so a second run of `up` only redeploys. The two keys may also come from files named by `AGENTGRAPH_APP_KEY_FILE` and `AGENTGRAPH_PROXY_KEYS_FILE`, as on a host; wrangler never sees them in its environment. The engine starts within five minutes, from a cron trigger. `npx wrangler tail` in the example folder follows it.

## What runs where

```
 Worker "agentgraph"
   cron, every 5 minutes --> Engine container, one instance
                               node bin/run.ts loop, data in /data
                               reaches GitHub, and box.internal, data.internal, gateway.internal, keys.internal
   box.internal/<id> ------> Box container, one per checkout, the sandbox image
                               reaches gateway.internal and the egress allowlist, per command
   data.internal ----------> R2 bucket agentgraph-data
   gateway.internal -------> GATEWAY_URL
   keys.internal ----------> the App key and the agent keys, read once at start
```

The engine is the same runner as on a host. `AGENTGRAPH_SANDBOX_URL` set to `http://box.internal` makes it run commands in boxes instead of docker. The checkout stays a git worktree on the engine's disk, and host git, merges and kept files work as there. <!-- code: src/remote.ts#remoteSandbox src/services.ts#makeProductionLayers -->

## Boxes

Each checkout gets its own box, named after the checkout, and destroys it when the checkout closes. A box whose last work did not come back is kept instead: the next command in the checkout pulls that work first, and a box left idle for 30 minutes writes `/work` and `/homes` to `kept/<id>.tgz` in the bucket before it stops. Before a command the work tree, the session home and the hub go to the box; after it, the work tree and the home come back. Both directions send only the git objects that changed, so ignored folders such as `node_modules` or `target` stay in the box, deletions travel, and a box cannot write through a link on the host. The news file is sent before the command and once a minute while it runs.

Commands in one checkout share the box, as they share the work tree under docker. A command that times out or is interrupted is killed with its children, and what it wrote comes back. A box that restarted gets the files and the toolchain again before the next command; the hub's `setup` is not run again. The toolchain step runs once per checkout in the box, with any host reachable. A hub `image` is refused: every box runs the sandbox image.

The box answers a small HTTP protocol, so any server that runs `examples/deploy/cloudflare/box.sh` behind it can stand in for Cloudflare.

## Networks

Egress is set per box, from the commands running in it. A box with only `none` commands running reaches nothing. During a session the box reaches `gateway.internal`, and with the hub's `network: egress` also the hosts in `infra/local/egress/allowlist`. The gateway forward keeps the path after `/v1`, never follows redirects, and applies `GATEWAY_HEADERS`. A check that runs next to a session in the same box shares the session's reach, unlike under docker, where each command has its own network.

## Models

The model gateway is yours. The Worker forwards every session request to `GATEWAY_URL`, so the key in the box is whatever the gateway accepts from it.

| Gateway | `GATEWAY_URL` | `GATEWAY_HEADERS` |
| --- | --- | --- |
| LiteLLM on a host or behind a Tunnel | `https://litellm.example.com/v1` | none, agent keys are LiteLLM keys |
| Cloudflare AI Gateway | `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/compat` | `{"cf-aig-authorization":"Bearer <token>","authorization":""}` with provider keys stored in the gateway |
| OpenRouter or another provider | its OpenAI-compatible base | `{"authorization":"Bearer <key>"}`, so the box never holds the key |

A header with an empty value is removed. ChatGPT subscription logins cannot run here; a LiteLLM that owns one runs elsewhere and is the gateway.

## Data

`/data` lives on the engine's disk. It is restored from R2 at start and saved every five minutes and on stop, keeping the previous copy as `data.tar.gz.previous`. Checkouts are not saved, so a crash or redeploy loses up to five minutes of run state, and a command's changes in its box reach the engine only when the command ends. The backup copies a live folder, so it can pair a run record with a trace from a moment earlier. A failed restore stops the engine rather than start empty over the backup.

## Not yet

- The App key is a Worker secret the engine reads from `keys.internal` into a file; a signer that keeps it in the Worker comes later.
- Runs and traces are in the backup, not a database.
- The studio does not run on Cloudflare.
- Image builds and `wrangler dev` need Docker. Tests cover the box protocol and the gateway, not a deploy.
