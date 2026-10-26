# Hosting

Each way to host the engine is a folder under `examples/deploy/`. The engine is the same everywhere: it reads its settings from the environment, keeps its data in one folder, and runs commands through a sandbox, either docker or a box server named by `AGENTGRAPH_SANDBOX_URL`. Only the folders know about a host. <!-- code: src/services.ts#makeProductionLayers -->

| Folder | Runs on | Sandbox | Tested |
| --- | --- | --- | --- |
| `vps` | any Linux host with Docker | docker on the host | compose config validates |
| `engine` | one `docker run` | docker on the host | builds from the `vps` Dockerfile |
| `k8s` | a cluster that allows a privileged pod | docker in a sidecar | manifests written, not applied |
| `aws` | one EC2 instance | the `vps` folder on it | Terraform written, not applied |
| `cloudflare` | Workers, Durable Objects, Containers and R2 | one box container per checkout | type check and `wrangler deploy --dry-run` |

None of these has run on a real account yet. Tests cover the relay, the model settings, the box protocol and the Cloudflare egress rules.

The folders share three pieces:

- `examples/deploy/engine/Dockerfile` is the engine image: the repo, Node, git and the docker CLI.
- `examples/deploy/engine/start.sh` starts the engine. Without a box server, it first brings up the gateway relay, the egress proxy and the internal networks from `sidecars.yaml`, and builds the sandbox image when missing.
- `examples/deploy/gateway/` is the gateway relay. It forwards every request to `GATEWAY_URL`, keeps the path and applies `GATEWAY_HEADERS`. Sandboxes reach it as `gateway`, on Cloudflare as `gateway.internal`.

Every folder takes `AGENTGRAPH_REPO`, `AGENTGRAPH_APP_ID`, the App key in `AGENTGRAPH_APP_KEY` or `AGENTGRAPH_APP_KEY_FILE`, `GATEWAY_URL`, `GATEWAY_HEADERS` and the [model settings](sandbox.md#models). Git ignores `.env`, `.env.*` and `*.pem`.

## VPS

On a Linux host with Docker and the compose plugin, from `examples/deploy/vps`:

```sh
cp .env.example .env                                   # fill in; DOCKER_GID is: stat -c %g /var/run/docker.sock
cp ~/path/to/app.pem app.pem && sudo chown 1000 app.pem && chmod 600 app.pem
sudo install -d -o 1000 -g 1000 /var/lib/agentgraph
docker compose up -d --build
```

The engine runs as uid 1000 and starts containers through the host's docker socket, so in effect it is root on the host. The data folder has the same path on the host and in the engine container, because docker resolves the engine's mounts on the host. Your gateway runs where you like; the relay reaches it at `GATEWAY_URL`. Do not run this on the same docker as `infra/local`: both use the networks `agentgraph-sandbox` and `agentgraph-models` and both answer to `gateway`.

## One image

```sh
sudo install -d -o 1000 -g 1000 /var/lib/agentgraph
docker build -t agentgraph-engine -f examples/deploy/engine/Dockerfile .
docker run -d --restart unless-stopped --env-file .env \
  --group-add "$(stat -c %g /var/run/docker.sock)" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /var/lib/agentgraph:/var/lib/agentgraph \
  agentgraph-engine
```

`start.sh` brings up the relay and the egress proxy beside it. Put the App key in `.env` as `AGENTGRAPH_APP_KEY`, or as `AGENTGRAPH_APP_KEY_FILE` with the file mounted.

## Kubernetes

`examples/deploy/k8s/agentgraph.yaml` is one Deployment and one volume claim. The pod runs the engine and a `docker:dind` sidecar that listens on `127.0.0.1` only, so the sandbox keeps its containers and internal networks without the node's docker socket. The sidecar is privileged, so use a cluster or node pool that allows it.

```sh
kubectl create secret generic agentgraph-env --from-env-file=.env
kubectl create secret generic agentgraph-app-key --from-file=app.pem
kubectl apply -f examples/deploy/k8s/agentgraph.yaml
```

Push the engine image to a registry the cluster can pull from and set it in the manifest, or use `kind load docker-image agentgraph-engine:local`. The sandbox, relay and egress images build inside the sidecar at start, and again after a pod restart, since its disk is an `emptyDir`.

## AWS

`examples/deploy/aws` makes one EC2 instance and runs the `vps` folder on it. Fargate has no docker daemon, so the sandbox could not run there. The instance has no inbound ports, requires IMDSv2 with a hop limit of 1 so containers cannot reach the metadata service, and is reached through SSM Session Manager.

```sh
cd examples/deploy/aws
terraform init && terraform apply -var repo=https://github.com/<owner>/<repo>.git
```

`repo` is a clone URL the instance can read, and `dir` the agentgraph folder in it when not the root. The output prints the `aws ssm start-session` command. On the instance, docker is installed and the repo cloned; fill in `examples/deploy/vps/.env` and `app.pem` with `sudo`, then run `docker compose up -d --build`. Secrets never pass through Terraform state or user data.

## Cloudflare

One Worker runs the engine and its sandboxes on Cloudflare Containers. You need an account with Containers, Node 24 and Docker for the image builds. From a checkout of agentgraph:

```sh
examples/deploy/cloudflare/up
```

`up` installs wrangler, runs `wrangler login` when needed, creates the R2 bucket `agentgraph-data`, and asks for what is not deployed yet:

| Secret | What it is |
| --- | --- |
| `AGENTGRAPH_APP_ENV` | Path to the App's `app.env`; empty creates the App with `node bin/setup-app.ts` |
| `AGENTGRAPH_REPO` | `owner/name` of the repo |
| `GATEWAY_URL` | Your model gateway's base; the request path is appended, `/v1` included |
| `AGENTGRAPH_PROXY_KEYS`, `GATEWAY_HEADERS`, `AGENTGRAPH_PROXY_URL`, `AGENTGRAPH_SESSION_ENV` | Optional, read from the environment only; names in `AGENTGRAPH_SESSION_ENV` are sent as secrets too |

Values already in the environment are used without asking, so a second `up` only redeploys. Keys may also come from `_FILE` settings; wrangler never sees them in its environment. A cron trigger starts the engine within five minutes. `npx wrangler tail` in the example folder follows it.

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

The engine is the same image as on a host, started by `engine.sh`. `AGENTGRAPH_SANDBOX_URL=http://box.internal` makes it run commands in boxes. The checkout stays a git worktree on the engine's disk. <!-- code: src/remote.ts#remoteSandbox -->

How boxes differ from docker:

- Commands in one checkout share one box. Before a command the work tree, the session home and the graph go to the box; after it, the work tree and home come back, as changed git objects only. Ignored folders such as `node_modules` stay in the box.
- A box's egress is set from the commands running in it, so a check next to a session shares the session's reach. A session reaches `gateway.internal`, and with `network: egress` the allowlist.
- A graph `image` is refused; every box runs the sandbox image. A restarted box gets the files and toolchain again, but not the graph's `setup`.
- A box idle for 30 minutes saves `/work` and `/homes` to `kept/<id>.tgz` in the bucket before it stops.
- A command's processes are found by `AGENTGRAPH_RUN` in their environment, so one that drops it outlives the command.

`/data` is restored from R2 at start and saved every five minutes and on stop, keeping the previous copy as `data.tar.gz.previous`. A crash can lose up to five minutes of run state, and a backup of a live folder can pair a run record with a slightly older trace. A failed restore stops the engine instead of starting empty. The App key is a Worker secret, runs live in the backup rather than a database, and the studio does not run here. ChatGPT logins cannot run on Cloudflare; a LiteLLM that owns one runs elsewhere and is the gateway.
