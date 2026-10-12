# Server sketches (not yet used)

Starting points for running bothub on a small Linux box later. Nothing here is deployed or tested.

- `bothub-runner.service`: the runner as a dedicated `bothub` user with memory, CPU and task
  limits and systemd hardening. Data in `/var/lib/bothub`.
- `litellm.service`: the LiteLLM compose stack from `infra/local`, bound to 127.0.0.1. LiteLLM
  plus Postgres wants several GB; on the 3.7 GB box use a lighter proxy instead.
- `cloudflare/`: Worker for GitHub webhooks (`wrangler.jsonc`) and the Access policy note.

Run containers on a server should use gVisor (`runsc`) as the Docker runtime: add
`--runtime=runsc` to `infra/local/sandbox/run.sh`.
