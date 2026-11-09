# What agentgraph is

agentgraph runs workflows on repository issues. A graph defines the agents, instructions, checks and steps. A step can run an agent, run a script or wait for a person. <!-- code: src/folder.ts#Graph src/workflow.ts#compileWorkflow -->

The engine reads a GitHub or folder tracker, drives runs and saves their state and traces. Agents ask for writes through [proposals](proposals.md); the engine checks permissions and runs the step's checks before applying them. The graph chooses which checks block and which proposals a step may return. <!-- code: src/main.ts#start src/run/attempt.ts#runAttempt src/run/settle.ts#writeProposals -->

Commands execute through a runner. The default uses Docker; other runners use remote sandboxes. Sessions use the selected harness and model provider. The studio shows graphs, runs and results. <!-- code: src/sandbox.ts#Runner src/harnesses.ts#harnessSession -->

## Read in this order

1. [Install and first run](local.md)
2. [The graph folder](reference.md): settings, agents, skills, checks and workflows
3. [Checks and results](checks.md)
4. [Workflows](workflows.md): triggers, steps and retries
5. [Running on GitHub](github.md)
6. [Hosting](hosting.md)
7. [Extending agentgraph](extending.md)

Reference: [CLI](cli.md), [Proposals](proposals.md), [Sandbox and models](sandbox.md), [Runs and data](runs.md).

Development: [Engine and code](patterns.md), [Bench](bench.md).

## Terms

| Term | Meaning |
| --- | --- |
| **graph** | Settings, agents, skills, checks, workflows, scripts and plugins |
| **agent** | A role file with a harness, model, tools, allowed proposals and prompt |
| **skill** | Instructions a step hands to its agent |
| **harness** | The program that runs an agent session |
| **session** | One harness conversation and its history |
| **workflow** | Steps and triggers for work on an issue |
| **step** | An agent, a script or a wait for a person |
| **check** | A script or judge that records a result; its mode controls failure handling |
| **result** | A check's JSON output, shaped by its `returns` |
| **try** | One attempt at a step |
| **proposal** | A write or action requested from the engine |
| **run** | One execution of a workflow |
| **retro** | A workflow started by the `feedback` trigger |
| **trace** | A run's event log |

<!-- code: src/folder.ts#Agent src/folder.ts#SkillFile src/folder.ts#Check src/workflow.ts#Run src/proposal.ts#Said src/run/hear.ts#isRetro src/trace.ts#Trace -->
