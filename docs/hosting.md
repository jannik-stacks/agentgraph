# Hosting <!-- untested -->

Each way to host the engine is a folder under `examples/deploy/`. The engine is the same everywhere: a named instance in the data root, environment overrides, commands through a [runner](sandbox.md#runners): docker on the host, or the `box` runner and the box server `AGENTGRAPH_SANDBOX_URL` names. <!-- code: src/services.ts#makeProductionLayers, src/services.ts#pickRunner, src/runners.ts#box -->

| Folder       | Runs on                                     | Sandbox                        | Tested                                     |
| ------------ | ------------------------------------------- | ------------------------------ | ------------------------------------------ |
| `vps`        | any Linux host with Docker                  | docker on the host             | compose config validates                   |
| `engine`     | one `docker run`                            | docker on the host             | builds from the `vps` Dockerfile           |
| `k8s`        | a cluster that allows a privileged pod      | docker in a sidecar            | manifests written, not applied             |
| `aws`        | one EC2 instance                            | the `vps` folder on it         | Terraform written, not applied             |
| `cloudflare` | Workers, Durable Objects, Containers and R2 | one box container per checkout | type check and `wrangler deploy --dry-run` |

None has run on a real account yet. The folders share the engine image (`examples/deploy/engine/Dockerfile`), `start.sh`, which brings up the gateway relay, egress proxy and networks from `sidecars.yaml` when there is no box server, and the relay in `examples/deploy/gateway/`, which sandboxes reach as `gateway`.

Every folder takes `AGENTGRAPH_REPO`, `AGENTGRAPH_APP_ID`, the App key in `AGENTGRAPH_APP_KEY` or `AGENTGRAPH_APP_KEY_FILE`, `GATEWAY_URL`, `GATEWAY_HEADERS` and the [model settings](sandbox.md#models). Git ignores `.env`, `.env.*` and `*.pem`.

## Named instance

The entrypoints run `loop --instance live`. Provision `live/instance.yaml` and its checkout
in the persistent data root before starting a service. The engine image itself needs no Git checkout.
Run these steps with write access to the volume, then give uid 1000 ownership:

```sh
data=/var/lib/agentgraph
mkdir -p "$data/live"
git clone https://github.com/owner/name.git "$data/live/checkout"
cat > "$data/live/instance.yaml" <<'YAML'
checkout: checkout
repo: owner/name
base: main
owner: your-login
tracker: github
loop: true
exported: {}
YAML
sudo chown -R 1000:1000 "$data/live"
```

Use the checkout's default branch for `base` and your GitHub login for `owner`. Clone private
repositories with your existing Git credentials. App and model credentials stay in the service
environment or secret files. Keep `AGENTGRAPH_REPO` consistent with the record. Omitted `graph`
selects the checkout's committed `.agentgraph/`, including when there is no local tracker origin.
The saved checkout must remain present across restarts. Update it with Git when deploying graph changes.
<!-- code: src/instance.ts#readInstance src/instance.ts#ensureGraph -->

## VPS

On a Linux host with Docker and the compose plugin, from `examples/deploy/vps`:

```sh
cp .env.example .env                                   # fill in; DOCKER_GID is: stat -c %g /var/run/docker.sock
cp ~/path/to/app.pem app.pem && sudo chown 1000 app.pem && chmod 600 app.pem
sudo install -d -o 1000 -g 1000 /var/lib/agentgraph
docker compose up -d --build
```

Provision the named instance above before `docker compose up`. The engine runs as uid 1000 with the host's docker socket, so in effect it is root on the host. The data folder has the same path on the host and in the container, because docker resolves mounts on the host. Do not share a docker with `infra/local`: both use the same networks and the name `gateway`.

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

Put the App key in `.env`, or set `AGENTGRAPH_APP_KEY_FILE` and mount the file.

## Kubernetes

`examples/deploy/k8s/agentgraph.yaml` is one Deployment and one volume claim. The pod runs the engine and a privileged `docker:dind` sidecar on `127.0.0.1`, so the sandbox works without the node's docker socket.

```sh
kubectl create secret generic agentgraph-env --from-env-file=.env
kubectl create secret generic agentgraph-app-key --from-file=app.pem
kubectl apply -f examples/deploy/k8s/agentgraph.yaml
```

Seed the volume claim with the same `live/instance.yaml` and `live/checkout` layout through a temporary pod before starting the Deployment. Push the engine image where the cluster can pull it and set it in the manifest. The other images build in the sidecar at each pod start.

## AWS

`examples/deploy/aws` makes one EC2 instance and runs the `vps` folder on it; Fargate has no docker daemon. The instance has no inbound ports, keeps containers off the metadata service, and is reached through SSM.

```sh
cd examples/deploy/aws
terraform init && terraform apply -var repo=https://github.com/<owner>/<repo>.git
```

`dir` names the graph folder when it is not at the root. Open the printed `aws ssm start-session`, fill in `examples/deploy/vps/.env` and `app.pem`, and run `docker compose up -d --build`. Secrets never pass through Terraform.

## Cloudflare

One Worker runs the engine and its sandboxes on Cloudflare Containers. You need Containers on the account, Node 24 and Docker. From a checkout of agentgraph:

```sh
examples/deploy/cloudflare/up
```

`up` logs wrangler in, creates the R2 bucket `agentgraph-data`, and asks for what is not deployed yet:

| Secret                                                                                       | What it is                                                                                                                       |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTGRAPH_APP_ENV`                                                                         | Path to the App's `app.env`; empty creates the App with `node bin/setup-app.ts`                                                  |
| `AGENTGRAPH_REPO`                                                                            | `owner/name` of the repo                                                                                                         |
| `GATEWAY_URL`                                                                                | Your model gateway's base; the request path is appended, `/v1` included                                                          |
| `AGENTGRAPH_PROXY_KEYS`, `GATEWAY_HEADERS`, `AGENTGRAPH_PROXY_URL`, `AGENTGRAPH_SESSION_ENV` | Optional, read from the environment only; only the model login names allowed by `AGENTGRAPH_SESSION_ENV` are sent as secrets too |

Before the first successful engine start, provision the same `live` folder locally and archive the data
root, including `live/checkout/.git` and `live/instance.yaml`:

```sh
tar -czf /tmp/agentgraph-data.tar.gz -C "$data" live
```

After `up` creates the bucket, upload this archive as `data.tar.gz` in `agentgraph-data` using the R2
dashboard. The next cron start restores it and selects `live`; an empty bucket cannot start a named
instance. Relative checkout paths make the record work under the container's `/data`. Backups retain
the checkout and record and exclude instance data locks.

Values already in the environment are used without asking, so a second `up` only redeploys. A cron trigger starts the engine within five minutes; `npx wrangler tail` follows it.

```
 Worker "agentgraph"
   cron, every 5 minutes --> Engine container, one instance
                               node bin/run.ts loop --instance live, data in /data
                               reaches GitHub, and box.internal, data.internal, gateway.internal, keys.internal
   box.internal/<id> ------> Box container, one per checkout, the sandbox image
                               reaches gateway.internal and the egress allowlist, per command
   data.internal ----------> R2 bucket agentgraph-data
   gateway.internal -------> GATEWAY_URL
   keys.internal ----------> the App key, the agent keys and the session variables, read once at start
```

The engine is the host image, with `AGENTGRAPH_RUNNER=box` and `AGENTGRAPH_SANDBOX_URL=http://box.internal`. Checkouts stay on the engine's disk. <!-- code: src/runners.ts#box, src/remote.ts#boxRunner, src/remote.ts#makeBoxRunner -->

How boxes differ from docker:

- One checkout has one box. The work tree, home and graph go in before each command, and changes come back as git objects. Ignored folders such as `node_modules` stay in the box.
- A box's egress follows the commands running in it, so a check beside a session shares its reach.
- `agi check` refuses a graph `image`, memory or cpu limits and host tools. A restarted box gets files and toolchain back, but not `setup`. <!-- code: src/remote.ts#whyBoxRefused -->
- A box idle for 30 minutes saves `/work` and `/homes` to `kept/<id>.tgz` in the bucket.
- Processes are found by `AGENTGRAPH_RUN` in their environment; one that drops it outlives its command.

`/data` is restored from R2 at start and saved every five minutes and on stop, with the previous copy kept. A crash can lose five minutes of run state. A failed restore stops the engine instead of starting empty. The studio does not run here, and a ChatGPT login needs a LiteLLM elsewhere as the gateway.

## Modal

`examples/plugins/modal/modal.ts` is a [runner plugin](plugins.md#runners) that runs each checkout in a Modal sandbox. Copy it into the host graph's `plugins/`, run `npm install modal` in that graph folder, and set `AGENTGRAPH_RUNNER=modal`, `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` in the instance's env file. `settings.yaml` names the image, which Modal pulls from a registry and which needs `git`, `setpriv` and `timeout`:

```yaml
plugins:
  modal:
    image: ghcr.io/you/agentgraph-sandbox:1
network: models
```

The `app` plugin setting names the Modal app; its default is `agentgraph`. <!-- code: examples/plugins/modal/modal.ts#makeModalRunner -->

The engine stays on your host with the checkouts; only commands run in Modal. A Modal sandbox has one network for its life, so a box reaches either nothing or the model gateway's addresses. `agi check` refuses a graph with sessions or `setup` without `network: models`, sessions beside checks or steps that run commands without network, or a gateway that is not a public HTTPS URL. At startup, the plugin terminates leftover boxes tagged with this data root only when their checkout is gone. <!-- code: examples/plugins/modal/modal.ts#makeModalRunner examples/plugins/modal/modal.ts#whyModalRefuses -->
