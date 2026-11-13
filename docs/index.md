# What agentgraph is

agentgraph runs workflows on repository issues. Graphs define steps; see [Workflows](workflows.md), [Proposals](proposals.md) and [Sandbox](sandbox.md) for execution details. <!-- code: src/folder.ts#Graph src/workflow.ts#compileWorkflow -->

## Read in this order

1. [Install and first run](local.md)
2. [The graph folder](reference.md): settings, agents, skills, checks and workflows
3. [Checks and results](checks.md)
4. [Workflows](workflows.md): triggers, steps and retries
5. [Running on GitHub](github.md)
6. [Hosting](hosting.md)
7. [Extending agentgraph](extending.md)

Reference: [CLI](cli.md), [Proposals](proposals.md), [Sandbox and models](sandbox.md), [Runs and data](runs.md), [Plugins](plugins.md).

Contributors: [Engine and code](patterns.md). Workflow comparisons: [Bench](bench.md).

## Terms

| Term | Meaning |
| --- | --- |
| **graph** | Settings, agents, skills, checks, workflows, scripts and plugins |
| **agent** | A role file defining a harness, model, tools, allowed proposals and prompt |
| **skill** | Instructions given to an agent |
| **harness** | The program that runs agent sessions |
| **session** | One harness conversation and its history |
| **workflow** | Steps and triggers for work on an issue |
| **step** | An agent, a script or a wait for a person |
| **check** | A script or judge that records a result; its mode controls failure handling |
| **result** | A check's JSON output, shaped by `returns` |
| **try** | One step attempt |
| **proposal** | Write or action requested from the engine |
| **run** | One workflow execution |
| **retro** | Workflow started by `feedback` |
| **trace** | Run event log |

<!-- code: src/types.ts#Agent src/folder.ts#SkillFile src/types.ts#Check src/types.ts#Run src/proposal.ts#Said src/run/hear.ts#isRetro src/types.ts#Trace -->
