# Sandbox and models

How a run is isolated and which models it can reach.

## The sandbox

Every session, script step and check script is one `docker run --rm` with the limits below. Nothing runs on the
host, and when docker or the `bothub-sandbox` network is not usable the run stops with the reason.

- read-only root filesystem, `/tmp` as a tmpfs, the operator's own non-root user, all capabilities
  dropped, `no-new-privileges`, memory, CPU and pid limits, no image pulls, and a watchdog that kills
  the container at the timeout,
- the checkout at `/work` and the session's home at `/home/agent`, both writable, with the bare
  mirror mounted read-only so refs and objects cannot be touched,
- the internal `bothub-sandbox` network. A session reaches the model proxy and an egress proxy that
  allows only GitHub and the npm registry. Scripts and checks have no network at all.

The docker socket is never mounted and no GitHub token goes inside. A session gets the proxy URL and
its own agent's key. Pushes and pull requests happen on the host, after the checks pass.

`setup` in `hub.yaml` is a shell script that runs once in each new checkout, with the proxy network,
before the first step. Use it to install dependencies: `npm ci --prefix kit --no-audit --no-fund`.
A setup that fails stops the run.

The image is built from `infra/local/sandbox`, and `smoke.sh` there checks it the way a run uses it.
Tests use a host sandbox that runs commands directly in a clone, with no network rules.

## Harnesses

An agent's `harness` picks the program that runs its session.

| Harness    | Notes                                                                       |
| ---------- | --------------------------------------------------------------------------- |
| `opencode` | Real tool allowlists, including patterned bash like `bash(git diff*)`       |
| `pi`       | Tools are all or nothing, so use it for read-only agents      |
| `claude`   | Claude Code on the model proxy's Anthropic endpoint                         |

Each is a small adapter in `core/src/harnesses.ts` that builds the command and turns the harness's
output into the same session events.

## Models

An agent names a model alias, never a vendor model. LiteLLM sits in front of every model, maps
aliases to upstreams, and gives each agent its own virtual key, so its logs show which agent spent
what. `BOTHUB_PROXY_URL` points at the proxy, and `BOTHUB_PROXY_KEYS` lists `name=key` pairs, one per
agent. Moving an alias from an API key to a subscription is a proxy config change; no agent file
changes. Aliases and routes are in `infra/local/litellm.config.yaml`.
