# Hosting <!-- untested -->

The host runs the engine and stores its data. A [runner](sandbox.md#runners) executes the commands. These deployment examples are untested on live accounts. <!-- code: src/services.ts#makeProductionLayers -->

| Deployment | Host |
| --- | --- |
| [VPS](../examples/deploy/vps) | Docker Compose |
| [Engine image](../examples/deploy/engine) | Container |
| [Kubernetes](../examples/deploy/k8s/agentgraph.yaml) | Cluster |
| [AWS](../examples/deploy/aws) | EC2 |
| [Cloudflare](../examples/deploy/cloudflare/up) | Workers, Containers and R2 |

<!-- code: examples/deploy/vps/compose.yaml examples/deploy/engine/Dockerfile examples/deploy/k8s/agentgraph.yaml examples/deploy/aws/main.tf examples/deploy/cloudflare/up -->

Set the [GitHub App credentials and repository](github.md#start-the-engine) and [model settings](sandbox.md#models). When using the model [gateway](sandbox.md#gateways), set `GATEWAY_URL` to the upstream model service. Supply `GATEWAY_HEADERS` as a JSON object if the gateway must set request headers, such as authorization. <!-- code: examples/deploy/engine/sidecars.yaml examples/deploy/gateway/forward.ts#forwardToGateway src/github.ts#github -->

## Named instance

The entrypoints run the loop for an [instance](local.md#named-instances-and-settings) named `live`. Persist its checkout, its settings and its data across restarts. The data includes run records, the Git mirror, session homes and logs. <!-- code: examples/deploy/engine/start.sh examples/deploy/cloudflare/engine.sh src/instance.ts#readInstance src/mirror.ts#makeSandbox src/store.ts#fileStore src/harnesses.ts#harnessSession -->

```text
live/
  checkout/
  instance.yaml
  data/
```

Configure the [instance record](runs.md#instanceyaml). The engine container runs as user 1000. Supply credentials through the service environment or secret files. <!-- code: examples/deploy/engine/Dockerfile examples/deploy/vps/compose.yaml src/main.ts#readEngineEnv -->

## VPS

The [VPS folder](../examples/deploy/vps) contains a Compose file and a sample environment file. The engine service mounts the Docker socket and the data directory. Set `DOCKER_GID` to the socket's group ID. Access to the socket grants control of the host. Keep the same absolute data path on both sides of the mount and use a separate Docker daemon from the local development stack. <!-- code: examples/deploy/vps/compose.yaml examples/deploy/vps/.env.example -->

## One image

The [engine folder](../examples/deploy/engine) contains the Dockerfile, its build exclusions, the startup script and the Compose definition for the model gateway and egress proxy. <!-- code: examples/deploy/engine/Dockerfile examples/deploy/engine/Dockerfile.dockerignore examples/deploy/engine/start.sh examples/deploy/engine/sidecars.yaml -->

## Kubernetes

The [manifest](../examples/deploy/k8s/agentgraph.yaml) uses privileged Docker-in-Docker and persistent storage. <!-- code: examples/deploy/k8s/agentgraph.yaml -->

## AWS

The [EC2 example](../examples/deploy/aws) provisions the host for the VPS Compose deployment. Supply secrets on the host outside Terraform. <!-- code: examples/deploy/aws/main.tf examples/deploy/aws/user-data.sh -->

## Cloudflare

Use the [provisioning script](../examples/deploy/cloudflare/up). Seed the R2 bucket `agentgraph-data` with `data.tar.gz` containing `live/instance.yaml` and the complete `live/checkout`, including `.git`. Include `live/data/` when restoring an existing instance. <!-- code: examples/deploy/cloudflare/up examples/deploy/cloudflare/engine.sh -->

The engine uses the remote [box runner](sandbox.md#runners). It restores its files at startup and writes a checkpoint to R2 every five minutes and on stop. A crash can lose changes since the last checkpoint. A failed restore stops startup. This deployment serves the engine only. <!-- code: examples/deploy/cloudflare/engine.sh src/remote.ts#makeBoxRunner -->

## Modal

Select the [Modal plugin](../examples/plugins/modal/modal.ts) with `AGENTGRAPH_RUNNER=modal` and supply `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`. Networks stay fixed for the lifetime of each sandbox. The plugin checks command networks and requires a public HTTPS model gateway. <!-- code: examples/plugins/modal/modal.ts#whyModalRefuses -->
