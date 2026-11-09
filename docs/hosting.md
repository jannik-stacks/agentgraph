# Hosting <!-- untested -->

The engine keeps instance state on the host and sends commands through a [runner](sandbox.md#runners). `local` uses Docker; `box` uses the server named by `AGENTGRAPH_SANDBOX_URL`. <!-- code: src/services.ts#makeProductionLayers src/services.ts#pickRunner src/runners.ts#box -->

`examples/deploy/` contains deployment recipes. They use the same engine image and gateway relay. These recipes have not been exercised on live accounts.

| Folder | Host | Commands run in |
| --- | --- | --- |
| `vps` | Linux with Docker Compose | Host Docker containers |
| `engine` | A single engine container | Host Docker containers |
| `k8s` | Kubernetes with a privileged sidecar | Docker-in-Docker |
| `aws` | EC2 | The VPS recipe |
| `cloudflare` | Workers, Containers and R2 | A box per checkout |

These examples take App credentials, `AGENTGRAPH_REPO`, `GATEWAY_URL`, `GATEWAY_HEADERS` and [model settings](sandbox.md#models). Their `live` instance name is a deployment choice.

## Named instance

The example entrypoints select `loop --instance live`. Before starting them, provision this layout on the persistent data volume:

```text
live/
  checkout/          repository clone with its graph
  instance.yaml
```

```yaml
checkout: checkout
repo: owner/name
base: main
owner: your-login
tracker: github
loop: true
exported: {}
```

Set `base` and `owner` for the repository. Relative paths resolve against the instance folder. An omitted `graph` selects the checkout's committed `.agentgraph/`. Keep the checkout and record across restarts; keep credentials in the service environment or secret files. The example containers use uid 1000. <!-- code: src/instance.ts#readInstance src/instance.ts#ensureGraph -->

## VPS

From `examples/deploy/vps`, copy `.env.example` to `.env`, supply the App key and provision `/var/lib/agentgraph/live`. Set `DOCKER_GID` to the host socket's group, then run `docker compose up -d --build`.

The Docker socket gives the engine control of the host. Mount the data folder at the same path inside and outside the container so Docker can resolve sandbox mounts. The recipe shares network names with `infra/local`; use separate Docker daemons.

## One image

Build with `docker build -t agentgraph-engine -f examples/deploy/engine/Dockerfile .`. Run it with the service env file, Docker socket, socket group and persistent data volume mounted at the host path. Mount the App key file if `AGENTGRAPH_APP_KEY_FILE` names one.

## Kubernetes

`examples/deploy/k8s/agentgraph.yaml` runs the engine with a privileged `docker:dind` sidecar and a persistent volume. Seed the volume with the named instance, set an engine image the cluster can pull, and create the env and App-key secrets before applying the manifest.

## AWS

`examples/deploy/aws` provisions EC2 and runs the VPS recipe. Connect through the printed SSM command, provision the named instance and fill in the VPS env and key files. Secrets stay outside Terraform.

## Cloudflare

`examples/deploy/cloudflare/up` provisions the Worker and R2 bucket. It requires Node 24, Docker and Containers enabled on the account. Supply `AGENTGRAPH_APP_ENV`, `AGENTGRAPH_REPO` and `GATEWAY_URL`; optional gateway and model settings come from the environment.

Seed the `agentgraph-data` bucket with `data.tar.gz` containing `live/instance.yaml` and the complete `live/checkout`, including `.git`. An empty bucket cannot supply the named instance.

The recipe starts the engine on a five-minute cron and uses `AGENTGRAPH_RUNNER=box` with `AGENTGRAPH_SANDBOX_URL=http://box.internal`. Checkouts remain on the engine disk; commands run in boxes. <!-- code: src/runners.ts#box src/remote.ts#boxRunner src/remote.ts#makeBoxRunner -->

The box runner transfers checkout files and returns changes as git objects. It refuses graph `image`, memory and CPU overrides, and host tools. A restarted box restores files and toolchains but does not rerun `setup`. <!-- code: src/remote.ts#whyBoxRefused -->

The recipe saves data to R2 every five minutes and on stop. A crash can lose state since the last save; a failed restore stops startup. It does not serve the studio.

## Modal

`examples/plugins/modal/modal.ts` supplies a [runner plugin](plugins.md#runners). Copy it into the host graph's `plugins/`, install `modal` there, and set `AGENTGRAPH_RUNNER=modal`, `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` in the instance env file.

```yaml
plugins:
  modal:
    image: ghcr.io/you/agentgraph-sandbox:1
network: models
```

The image needs `git`, `setpriv` and `timeout`. The plugin's `app` setting defaults to `agentgraph`. The engine keeps checkouts on the host. <!-- code: examples/plugins/modal/modal.ts#makeModalRunner -->

Modal fixes a sandbox's network for its lifetime. The plugin validates that the graph's command networks can be preserved and requires a public HTTPS model gateway. <!-- code: examples/plugins/modal/modal.ts#whyModalRefuses -->
