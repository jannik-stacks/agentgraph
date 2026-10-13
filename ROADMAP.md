# bothub roadmap

One codebase that runs on a laptop first, then on a VPS or in managed sandboxes by swapping
backends, never by forking code. Each milestone ends with something you can run.

## Seams that make it portable

| Seam | Local | VPS | Later |
|---|---|---|---|
| Sandbox | docker run, hardened | docker with gVisor (`runsc`) | Kata or Firecracker on KVM hosts, Cloudflare Containers via celld, managed sandboxes |
| Models | LiteLLM in compose, ChatGPT subscription, Ollama | same compose, or LiteLLM on a bigger box | AI Gateway for API keys |
| Events | local issue files, watched | GitHub App webhooks through a tunnel | webhook Worker and a queue |
| Issues | `issues/*.md` | GitHub issues | same |
| Run store | data dir on disk | data dir on a volume | R2 through `Files` |
| UI | BHM on localhost | BHM behind Cloudflare Access | same |

## Milestones

1. **Real local run.** `bothub serve` on a local hub, a `/bothub` comment in an issue file, triage
   on local qwen, implement with opencode on the subscription inside the sandbox, checks, review,
   result on a branch in a throwaway origin, live in the dashboard.
2. **Hardened core.** Enforced or warned config, explicit job closure, fail-closed checks, branch
   and PR handoff, journaled idempotent apply, event dedupe, crash reconciliation, branch locks,
   resolved model per run, fault scenarios in `bothub sim`.
3. **One-command stack.** bothub itself as a container (serve, API, BHM), added to the compose
   stack; config only through env and the hub repo; `bothub doctor` checks every dependency.
4. **GitHub mode.** GitHub App, webhook receiver with signature check, tunnel for local testing,
   a test repository, the same workflows as local mode.
5. **Portable sandbox.** A `Sandbox` interface with docker, docker plus gVisor and remote
   backends; the VPS profile in `infra/server` with systemd or compose, gVisor, Cloudflare Tunnel
   and Access.
6. **Learning loop.** Run memory summaries, the gardener proposing notes, `decide` checks on the
   local decision model, the correction ladder from note to check.
7. **Budgets and cost.** Runs per day, minutes and spend enforced; usage per bot on the dashboard.
8. **Evals.** A daily small real-model run on fixed tasks built from merged PRs, each run with and
   without a given note or skill, so a note has to show it changes outcomes. `spec` issues list
   the paths and tests that prove them, checked by a link script. Offered skills can load their
   full body through a read tool. Workflows that keep failing turn themselves off.
