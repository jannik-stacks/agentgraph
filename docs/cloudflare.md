# Running on Cloudflare

One Worker runs the engine and its sandboxes on Cloudflare Containers. You need a Cloudflare account with Containers, Node 24 or later and Docker for the image builds. Commands run from `agentgraph/`.

```sh
examples/deploy/cloudflare/up
```

`up` installs wrangler into the example folder, runs `wrangler login` when you are not logged in, creates the R2 bucket `agentgraph-data`, and asks for what is not deployed yet:

| Secret | What it is |
| --- | --- |
| `AGENTGRAPH_APP_ENV` | Path to the App's `app.env`; empty creates the App with `node bin/setup-app.ts` |
| `AGENTGRAPH_REPO` | `owner/name` of the repo the engine works on |
| `GATEWAY_URL` | Your model gateway's base; a request's path is appended as it is, `/v1` included |
| `AGENTGRAPH_PROXY_KEYS` | Optional, read from the environment only: gateway keys per agent, as in [Models](sandbox.md#models) |
| `GATEWAY_HEADERS` | Optional, read from the environment only; see below |
| `AGENTGRAPH_PROXY_URL`, `AGENTGRAPH_SESSION_ENV` | Optional, read from the environment only; see [Hosting](hosting.md#models). Each name in `AGENTGRAPH_SESSION_ENV` is sent as a secret too |

Values already in the environment are used without asking, so a second run of `up` only redeploys. The keys may also come from files named by their `_FILE` settings, as on a host; wrangler never sees them in its environment. The engine starts within five minutes, from a cron trigger. `npx wrangler tail` in the example folder follows it.

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
   keys.internal ----------> the App key, the agent keys and the session variables, read once at start
```

The engine is the same runner and the same image as on a host, `examples/deploy/engine/Dockerfile`, started by `engine.sh` instead of `start.sh`. `AGENTGRAPH_SANDBOX_URL` set to `http://box.internal` makes it run commands in boxes instead of docker. The checkout stays a git worktree on the engine's disk, and host git, merges and kept files work as there. <!-- code: src/remote.ts#remoteSandbox src/services.ts#makeProductionLayers -->

## Boxes

Each checkout gets its own box, named after the checkout, and destroys it when the checkout closes. A box whose last work did not come back is kept instead: the next command in the checkout pulls that work first, and a box left idle for 30 minutes writes `/work` and `/homes` to `kept/<id>.tgz` in the bucket before it stops. Before a command the work tree, the session home and the graph go to the box; after it, the work tree and the home come back. Both directions send only the git objects that changed, so ignored folders such as `node_modules` or `target` stay in the box, deletions travel, and a box cannot write through a link on the host. The news file is sent before the command and once a minute while it runs.

Commands in one checkout share the box, as they share the work tree under docker. When a command ends, times out or is interrupted, every process it started is killed, as when its container exits under docker, and what it wrote comes back. A box that restarted gets the files and the toolchain again before the next command; the graph's `setup` is not run again. The toolchain step runs once per checkout in the box, with any host reachable. A graph `image` is refused: every box runs the sandbox image.

The box answers a small HTTP protocol, so any server that runs `examples/deploy/cloudflare/box.sh` behind it can stand in for Cloudflare.

## Networks

Egress is set per box, from the commands running in it. A box with only `none` commands running reaches nothing. During a session the box reaches `gateway.internal`, and with the graph's `network: egress` also the hosts in `infra/local/egress/allowlist`. The gateway forward keeps the request's path, never follows redirects, and applies `GATEWAY_HEADERS`, the same code as the relay on other hosts. A check that runs next to a session in the same box shares the session's reach, unlike under docker, where each command has its own network.

## Models

The model gateway is yours. The Worker forwards every session request to `GATEWAY_URL`, so the key in the box is whatever the gateway accepts from it, or none when `GATEWAY_HEADERS` carries the credential. [Hosting](hosting.md#models) lists the settings for a provider key, LiteLLM, a subscription behind a proxy, a harness's own login, Vercel AI Gateway, OpenRouter, Cloudflare AI Gateway and any compatible URL; here `gateway.internal` stands for `gateway:4000`. A header with an empty value is removed. ChatGPT subscription logins cannot run here; a LiteLLM that owns one runs elsewhere and is the gateway.

## Data

`/data` lives on the engine's disk. It is restored from R2 at start and saved every five minutes and on stop, keeping the previous copy as `data.tar.gz.previous`. Checkouts are not saved, so a crash or redeploy loses up to five minutes of run state, and a command's changes in its box reach the engine only when the command ends. The backup copies a live folder, so it can pair a run record with a trace from a moment earlier. A failed restore stops the engine rather than start empty over the backup.

## Not yet

- The App key is a Worker secret the engine reads from `keys.internal` into a file; a signer that keeps it in the Worker comes later.
- Runs and traces are in the backup, not a database.
- The processes of a command are found by `AGENTGRAPH_RUN` in their environment, so one that drops it outlives its command.
- The studio does not run on Cloudflare.
- Image builds and `wrangler dev` need Docker. Tests cover the box protocol and the gateway, and `npm run check` in the example folder type-checks and bundles the Worker without building images; nothing covers a deploy.
