# Hosting

Each way to host the engine is a plain folder under `examples/deploy/`. The engine itself is the same everywhere: it reads its settings from the environment, keeps its data in one folder, and runs commands through a sandbox, either docker or a box server named by `AGENTGRAPH_SANDBOX_URL`. Only the folders know about a host. <!-- code: src/services.ts#makeProductionLayers -->

| Folder | Runs on | Sandbox | Ready |
| --- | --- | --- | --- |
| [`cloudflare`](cloudflare.md) | Workers, Durable Objects, Containers and R2 | one box container per checkout | type check and `wrangler deploy --dry-run` pass; never deployed |
| `vps` | any Linux host with Docker | docker on the host | compose config validates; not run end to end |
| `engine` | one `docker run` | docker on the host | builds from the same Dockerfile as `vps`; not run end to end |
| `k8s` | any cluster that allows a privileged pod | docker in a sidecar | manifests written; not applied |
| `aws` | one EC2 instance | the `vps` folder on it | Terraform written; not validated or applied |

The pieces they share:

- `examples/deploy/engine/Dockerfile` is the engine image for every folder, Cloudflare included. It holds the repo, Node, git and the docker CLI.
- `examples/deploy/engine/start.sh` starts the engine. Without a box server it first brings up `sidecars.yaml` (the gateway relay, the egress proxy and the internal networks) and builds the sandbox image when missing.
- `examples/deploy/gateway/` is the gateway relay. It forwards every request to `GATEWAY_URL`, keeps the path, applies `GATEWAY_HEADERS` and streams the answer back. Sandboxes reach it as `gateway`, on Cloudflare as `gateway.internal`.

All folders use the same names: `AGENTGRAPH_REPO`, `AGENTGRAPH_APP_ID`, the App key in `AGENTGRAPH_APP_KEY` or `AGENTGRAPH_APP_KEY_FILE`, `GATEWAY_URL`, `GATEWAY_HEADERS` and the [model settings](#models). Env files and keys stay out of git: `.env`, `.env.*` and `*.pem` are ignored.

## VPS

On a Linux host with Docker and the compose plugin, from `examples/deploy/vps`:

```sh
cp .env.example .env                                   # fill in; DOCKER_GID is: stat -c %g /var/run/docker.sock
cp ~/path/to/app.pem app.pem && sudo chown 1000 app.pem && chmod 600 app.pem
sudo install -d -o 1000 -g 1000 /var/lib/agentgraph
docker compose up -d --build
```

The engine runs as uid 1000 and starts one container per command through the host's docker socket, which makes it root on the host in effect. The data folder has the same path on the host and in the engine container, because docker resolves the engine's bind mounts on the host. A LiteLLM or any other gateway runs where you like; the relay reaches it at `GATEWAY_URL`. Do not run this folder on the same docker as `infra/local`, since both use the networks `agentgraph-sandbox` and `agentgraph-models` and both answer to `gateway` on them.

## One image

The engine image alone, with the host's docker:

```sh
sudo install -d -o 1000 -g 1000 /var/lib/agentgraph
docker build -t agentgraph-engine -f examples/deploy/engine/Dockerfile .
docker run -d --restart unless-stopped --env-file .env \
  --group-add "$(stat -c %g /var/run/docker.sock)" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /var/lib/agentgraph:/var/lib/agentgraph \
  agentgraph-engine
```

`start.sh` brings up the relay and the egress proxy beside it on the same docker. The App key goes in `.env` as `AGENTGRAPH_APP_KEY_FILE` with the file mounted, or as `AGENTGRAPH_APP_KEY`.

## Kubernetes

`examples/deploy/k8s/agentgraph.yaml` is one Deployment and one volume claim. The pod has the engine and a `docker:dind` sidecar that listens on `127.0.0.1` only, so the sandbox keeps its per-command containers and internal networks without a docker socket on the node. The sidecar is privileged: use a cluster or node pool where that is allowed.

```sh
kubectl create secret generic agentgraph-env --from-env-file=.env
kubectl create secret generic agentgraph-app-key --from-file=app.pem
kubectl apply -f examples/deploy/k8s/agentgraph.yaml
```

Push the engine image to a registry the cluster can pull from and set it in the manifest, or load it into a local cluster with `kind load docker-image agentgraph-engine:local`. The sandbox, relay and egress images are built inside the sidecar at start, and again after a pod restart, since the sidecar's disk is an `emptyDir`.

## AWS

`examples/deploy/aws` makes one EC2 instance and runs the `vps` folder on it. EC2 rather than ECS: Fargate has no docker daemon and no privileged containers, so the sandbox could not isolate commands there, while one instance runs the compose file unchanged. The instance has no inbound ports, requires IMDSv2 with a hop limit of 1 so containers cannot reach the metadata service, and is reached through SSM Session Manager.

```sh
cd examples/deploy/aws
terraform init && terraform apply -var repo=https://github.com/<owner>/<repo>.git
```

`repo` is a clone URL the instance can read, and `dir` the agentgraph folder inside it when that is not the root. The output prints the `aws ssm start-session` command. On the instance, `cloud-init` has installed docker and cloned the repo; fill in `examples/deploy/vps/.env` and `app.pem` there with `sudo`, then run `docker compose up -d --build`. Secrets never pass through Terraform state or user data.

## Models

Sessions reach models through three settings, and no setting names a provider:

| Setting | Meaning |
| --- | --- |
| `AGENTGRAPH_PROXY_URL` | The base URL each harness talks to: one URL, or `harness=url` pairs such as `opencode=http://gateway:4000/v1,claude=http://gateway:4000`. A harness with an empty URL uses its own endpoint. Default `http://gateway:4000/v1` |
| `AGENTGRAPH_PROXY_KEYS` | `agent=key` pairs; `*` is the key of every agent without its own. An agent without a key gets none, for a harness with its own login or a gateway that adds the credential |
| `AGENTGRAPH_SESSION_ENV` | Names of engine variables every session gets as secrets, such as `CLAUDE_CODE_OAUTH_TOKEN`; each may also come from a `<NAME>_FILE` file |

Through the relay, `GATEWAY_URL` is the upstream and `GATEWAY_HEADERS` a JSON object of headers to set, or to remove when empty, so a provider key can stay with the relay and never enter a sandbox. The relay keeps the request path: opencode and pi call `<url>/chat/completions` or `<url>/responses`, Claude Code calls `<url without /v1>/v1/messages`. <!-- code: src/harnesses.ts#harnessSession examples/deploy/gateway/forward.ts#forwardToGateway -->

A direct provider key, kept in the relay:

```sh
GATEWAY_URL=https://api.openai.com
GATEWAY_HEADERS={"authorization":"Bearer sk-..."}
```

LiteLLM, with one virtual key per agent:

```sh
GATEWAY_URL=https://litellm.example.com
AGENTGRAPH_PROXY_KEYS=implementor=sk-...,reviewer=sk-...
```

A subscription behind a proxy, such as a LiteLLM that owns a ChatGPT login as in `infra/local`: the same lines as LiteLLM, with agents on its subscription aliases. The login stays in that one LiteLLM; never run two against the same token store.

The harness's own login with no gateway, here Claude Code on a subscription token from `claude setup-token`:

```sh
AGENTGRAPH_PROXY_URL=claude=,*=http://gateway:4000/v1
AGENTGRAPH_SESSION_ENV=CLAUDE_CODE_OAUTH_TOKEN
CLAUDE_CODE_OAUTH_TOKEN_FILE=/run/secrets/claude-token
```

The session then calls `api.anthropic.com` itself, so the hub needs `network: egress` with that host in `infra/local/egress/allowlist`. The token is inside the sandbox, like any key the harness holds.

Vercel AI Gateway:

```sh
GATEWAY_URL=https://ai-gateway.vercel.sh
GATEWAY_HEADERS={"authorization":"Bearer <AI Gateway key>"}
```

OpenRouter:

```sh
GATEWAY_URL=https://openrouter.ai/api
GATEWAY_HEADERS={"authorization":"Bearer sk-or-..."}
```

Cloudflare AI Gateway, with provider keys stored in the gateway. Its OpenAI-compatible and Anthropic endpoints have different paths, so the harnesses get their own URLs:

```sh
GATEWAY_URL=https://gateway.ai.cloudflare.com/v1/<account>/<gateway>
GATEWAY_HEADERS={"cf-aig-authorization":"Bearer <token>","authorization":""}
AGENTGRAPH_PROXY_URL=opencode=http://gateway:4000/compat,pi=http://gateway:4000/compat,claude=http://gateway:4000/anthropic
```

Any other OpenAI- or Anthropic-compatible URL works the same way: its base in `GATEWAY_URL`, its credential in `GATEWAY_HEADERS` or `AGENTGRAPH_PROXY_KEYS`. On Cloudflare the relay is the Worker, so write `gateway.internal` for `gateway:4000`.

An agent's `model` is whatever name the endpoint expects, such as a LiteLLM alias, `anthropic/claude-sonnet-4.5` on OpenRouter or a provider's own model id.

## Not tested yet

Nothing here has run on a real account or cluster. The parts covered by tests are the relay, the Cloudflare egress rules, the model settings and the box protocol; `wrangler deploy --dry-run` bundles the Worker. Untested until a real run: the image builds (they need registry access), compose bringing up the sidecars from inside the engine container, the dind sidecar, the Terraform plan, Claude Code's subscription token through the relay, and every gateway's path and header handling beyond what the relay test fakes.
