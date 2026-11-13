# Hosting <!-- untested -->

The host keeps state; [runners](sandbox.md#runners) execute commands. <!-- code: src/services.ts#makeProductionLayers -->

These deployment recipes are untested on live accounts.

| Recipe | Host |
| --- | --- |
| [VPS](../examples/deploy/vps) | Docker Compose |
| [Engine](../examples/deploy/engine) | Container |
| [Kubernetes](../examples/deploy/k8s/agentgraph.yaml) | Cluster |
| [AWS](../examples/deploy/aws) | EC2 |
| [Cloudflare](../examples/deploy/cloudflare/up) | Workers, Containers, R2 |

Supply App credentials, `AGENTGRAPH_REPO`, `GATEWAY_URL`, `GATEWAY_HEADERS` and [model settings](sandbox.md#models).

## Named instance

Entrypoints select `loop --instance live`.

```text
live/
  checkout/
  instance.yaml
```

Persist both across restarts. Configure the [record](runs.md#instanceyaml). <!-- code: src/instance.ts#readInstance -->

Containers use uid 1000. Keep credentials in service environments or secret files.

## VPS

Follow the [recipe](../examples/deploy/vps) for commands and socket-group configuration.

The Docker socket grants host control. Use matching data paths on the host and in containers. Use a separate Docker daemon from `infra/local`.

## One image

The [engine recipe](../examples/deploy/engine) covers builds and required mounts.

## Kubernetes

The [manifest](../examples/deploy/k8s/agentgraph.yaml) requires privileged Docker-in-Docker and persistent storage.

## AWS

The [EC2 recipe](../examples/deploy/aws) runs the VPS recipe. Keep secrets outside Terraform.

## Cloudflare

Follow the [provisioning recipe](../examples/deploy/cloudflare/up).

Seed the R2 bucket `agentgraph-data` with `data.tar.gz` containing `live/instance.yaml` and the complete `live/checkout`, including `.git`.

See [box capabilities](sandbox.md#runners).

Restarts restore files and toolchains without rerunning `setup`. <!-- code: src/remote.ts#whyBoxRefused -->

R2 checkpoints run every five minutes and on stop. A crash can lose changes since the last checkpoint. A failed restore stops startup. The recipe does not serve the studio.

## Modal

Use the [plugin recipe](../examples/plugins/modal/modal.ts) with `AGENTGRAPH_RUNNER=modal`, `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`.

Networks stay fixed for each sandbox's lifetime; the plugin validates command networks. The model gateway requires public HTTPS. <!-- code: examples/plugins/modal/modal.ts#whyModalRefuses -->
