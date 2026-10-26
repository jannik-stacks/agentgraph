# What agentgraph is

agentgraph runs coding agents on a repository's issues. People start and steer work with `/agent` comments or labels. Agents work on branches in Docker sandboxes, scripts and judge agents check the work, and people merge it.

The runner on the host polls GitHub, or a local folder that stands in for it. It starts sandbox sessions and records each run. Sessions reach models through a proxy and return [proposals](proposals.md). Only the runner holds a GitHub token, and it applies proposals after the checks pass. The studio, a local web UI, shows the graph and every run.

```
   /agent comment or label on an issue
                  |
                  v
   +-----------------------------+             +-----------------------------+
   | engine, on the host         |             | sandbox, one per session    |
   | reads the graph and drives  |-- start --->| the agent edits a worktree  |
   | the workflow step by step   |<-proposals--| and calls models via proxy  |
   +-----------------------------+             +-----------------------------+
          |                ^
          v                | failed: feedback, next try
   +-----------------------------+
   | checks: scripts, then judge |
   | agents, in parallel         |
   +-----------------------------+
          |
          v passed
   push the branch, open a pull request, wait for a person to merge
```

## Read in this order

1. [Install and first run](local.md)
2. [The graph folder](reference.md): `.agentgraph/` and every field
3. [Checks and results](checks.md)
4. [Workflows](workflows.md): triggers, steps, retries and waiting for people
5. [Running on GitHub](github.md)
6. [Hosting](hosting.md): VPS, Kubernetes, AWS and Cloudflare

Reference: [CLI](cli.md), [Proposals](proposals.md), [Sandbox and models](sandbox.md), [Runs and data](runs.md).

Working on agentgraph: [Engine and code](patterns.md), [Bench](bench.md).

## Words

| Word | Meaning |
| --- | --- |
| **graph** | What a repo keeps in `.agentgraph/`: settings, agents, skills, checks, workflows and scripts |
| **agent** | A role file: harness, model, tools, allowed proposals and its system prompt |
| **skill** | Instructions a step hands to its agent |
| **harness** | The program that runs a session: Claude Code, Codex, opencode or pi |
| **session** | One harness conversation and its history |
| **workflow** | Ordered steps on an issue, started by an `on` trigger |
| **step** | An agent with a skill, a script, or a wait for a person |
| **check** | A script or judge agent run on a try or an ended run; its mode says whether a failed result blocks, warns or is only recorded |
| **result** | What a check gives, a JSON object its `returns` describes, kept in the run's [check record](runs.md#the-check-record) |
| **try** | One attempt at a step; a retry resumes its session |
| **proposal** | A write an agent asks the engine to make, such as a comment or a push |
| **run** | One workflow on one issue, until it is done or stopped |
| **trace** | A run's event log |

"Agent" is the role file, "agentgraph" the system, and "bot" the GitHub account that posts its writes. Issue, pull request, label, review and base keep their GitHub meanings.
