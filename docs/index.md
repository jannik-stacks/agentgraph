# What agentgraph is

agentgraph runs workflows on repository issues. You describe the work in a graph, a folder of Markdown and YAML files. The engine reads the issue, runs the steps, checks the proposed changes and records what happened. The studio lets you inspect the graph and its runs. <!-- code: src/folder.ts#loadGraph src/run/drive.ts#runWorkflow src/run/attempt.ts#runAttempt src/store.ts#fileStore studio/served.ts#readInstanceServed -->

## Read in this order

1. [Install and first run](local.md) to try the starter on an issue.
2. [Workflows](workflows.md) explains what starts work and how a step advances, retries or waits.
3. [Checks and results](checks.md) explains how to evaluate a try.
4. [Proposals](proposals.md) describes the actions an agent or script can request.
5. [The graph folder](reference.md) lists the files, fields and defaults.
6. [Running on GitHub](github.md) covers repository access and project boards.
7. [Hosting](hosting.md) shows how to keep the engine running.
8. [Extending agentgraph](extending.md) explains where to add your own behavior.

**Reference** covers the [CLI](cli.md), [sandbox and models](sandbox.md), [runs and data](runs.md), [plugins](plugins.md) and [Bench](bench.md).

## Maintainers

- [Architecture](architecture.md) follows an issue through one pass of the engine.
- [Types and schemas](types.md) shows how file formats, service interfaces and stored records fit together.
- [Code layout](layout.md) maps the files and the imports each layer allows.
- [Conventions](patterns.md) explains how to name, test and check a change.

## Terms

| Term | Meaning |
| --- | --- |
| **graph** | A folder defines the settings, agents, skills, checks and workflows for a repository. It can include scripts and plugins. |
| **instance** | An instance associates one checkout with its settings, tracker folder and data folder under the data root. |
| **tracker** | The tracker supplies issues and applies proposed actions on GitHub or in a local folder. A plugin can supply another tracker. |
| **runner** | The runner executes commands in local Docker or a remote box, or through a plugin. |
| **agent** | An agent file defines a role's instructions, harness, model, tools and allowed proposals. |
| **skill** | A skill supplies instructions for an agent to follow. |
| **harness** | A harness is the program that runs an agent conversation. |
| **provider** | A provider supplies the model login or key a harness uses. |
| **session** | A session is one harness conversation with its history. |
| **workflow** | A workflow defines when work starts and the steps to take on an issue. |
| **step** | A step invokes an agent, runs a script or waits for a person. |
| **check** | A script or judge evaluates the work and records a result. The check's mode determines what happens on failure. |
| **judge** | A judge is an agent that evaluates a check and records the result. |
| **result** | A result records what a check measured. The check can define its JSON shape with `returns`. |
| **try** | A try is one attempt at a step. |
| **round** | A round counts one return along a step's `back` edge. |
| **proposal** | A proposal requests an action from the engine. |
| **run** | A run is one execution of a workflow. |
| **loop** | The long-running `agi loop` process checks issues on a timer and drives runs. |
| **drive** | To drive a run is to move it forward step by step until it waits, finishes or stops. |
| **router** | A router is a comment workflow with a step granted `tell`, so it can pass text to another run. |
| **aside** | An aside is a side session that answers a comment at a human wait. It can reply while the run stays on that step or request a return to work. |
| **parked** | A parked run waits after an engine error. Most failures park it on the second attempt. A host sandbox error can park it immediately. |
| **quiet workflow** | A feedback or conflict workflow skips public status updates and normally stops where another workflow would ask a person. |
| **base** | The base is the branch a run's work starts from and its pull request targets. |
| **retro** | A retro is a run of a workflow with `on: feedback`, started after work on the issue settles or a person leaves feedback. |
| **trace** | The trace records events and decisions during a run. |

<!-- code: src/folder.ts#Graph src/types.ts#Agent src/folder.ts#SkillFile src/types.ts#Check src/instance.ts#Instance src/instance.ts#ensureInstance src/tracker.ts#Tracker src/sandbox.ts#Runner src/harnesses.ts#Provider bin/run.ts src/run/drive.ts#runWorkflow src/workflow.ts#transition src/run/execute.ts#runJudge src/run/hear.ts#findRouter src/run/follow.ts#runAside src/run/settle.ts#isParked src/workflow.ts#isQuiet src/workflow.ts#Workflow src/run/trigger.ts#tick src/run/hear.ts#isRetro src/proposal.ts#Said src/types.ts#Trace -->
