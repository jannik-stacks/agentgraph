# Workflows

A workflow runs ordered steps on a repository issue. Each run records how far it got and what it needs to continue. See the [field reference](reference.md#workflows) and [terms](index.md#terms). <!-- code: src/workflow.ts#Workflow src/workflow.ts#transition src/types.ts#Run -->

## Steps

In this workflow, an agent changes the code, a check tests it and a reviewer can send it back. The last step waits for a person. <!-- code: src/workflow.ts#compileWorkflow src/workflow.ts#transition -->

```yaml
on: issue_comment
branch: agentgraph/{issue}
steps:
  implement:
    agent: implementor
    checks: [tests]
  review:
    agent: reviewer
    back: implement
    until: the change meets the issue and tests cover it
  merge: { wait: human, back: implement }
```

Define the steps in execution order in `workflows/<name>.md`. Each step runs an `agent`, executes a script with `run`, or waits with `wait: human`. If you omit `steps`, the workflow body prompts a single agent step. See [step and skill defaults](reference.md#steps). <!-- code: src/workflow.ts#compileWorkflow -->

### Script steps and grants

A script must exit with code 0 for its try to pass. It can also return a fenced block of [proposals](proposals.md#kinds). For example, it can read [traces](checks.md#reading-traces) and decide whether to [start a child run](#dispatch). <!-- code: src/run/attempt.ts#runAttempt src/workflow.ts#compileWorkflow -->

## What starts a run

| Trigger | When a run starts |
| --- | --- |
| `issue_comment` | A trusted person writes `/agent` or `@agent` outside quotes and code. An unnamed request selects the first comment workflow. |
| `issues.label` | A trusted person adds the configured label to an open issue. Removing that label stops its live run. |
| `issues.column` | An open issue enters the configured Status column. If the workflow also names a label, the engine adds it. Leaving the column does not stop the run. |

<!-- code: src/event.ts#findRequest src/workflow.ts#isIssueTriggered src/run/trigger.ts#tick src/workflow.ts#getEventOutcome -->

A completed (`done`) run of the same workflow blocks another label start on that issue. After a stopped run, adding the label again can start a new run. If a batch contains several changes to the same label, the engine ignores additions superseded by a later addition or removal. Only one work run can act on the issue at a time. <!-- code: src/run/trigger.ts#tick -->

Pull request comments reach the run on the corresponding issue. Unmarked comments supply context unless a workflow [hears them](#what-a-live-run-hears). The engine leaves an eyes reaction on comments it accepts. Other ways to start a run include [dispatch](#dispatch), [feedback](#retros) and [conflict handling](#when-the-base-or-the-graph-moves). <!-- code: src/run/trigger.ts#tick src/run/trigger.ts#instruct src/run/follow.ts#runCatchUp -->

### Commands

Use `/agent <text>` to send a request. A colon selects a command. <!-- code: src/event.ts#parseAgentRequest src/workflow.ts#pickCommandTarget -->

| Command | Effect |
| --- | --- |
| `/agent:stop [reason]` | Ends the run and records the reason. |
| `/agent:cancel` | Interrupts the running step and asks how to go on. |
| `/agent:restart` | Starts the newest workflow again. |
| `/agent:restart:<step>` | Starts the workflow again at the named step. |
| `/agent:<workflow> [text]` | Starts the named comment workflow or answers its live run. |
| `/agent:<workflow>:stop [reason]` | Ends the named workflow's run. |
| `/agent:<workflow>:cancel` | Interrupts that workflow's running step and asks how to go on. |
| `/agent:<workflow>:restart[:<step>]` | Starts the named workflow again, optionally at a particular step. |

<!-- code: src/workflow.ts#pickCommandTarget src/workflow.ts#cancelled src/workflow.ts#getEventOutcome src/run/trigger.ts#tick -->

The [command settings](reference.md#settingsyaml) control which trusted people can use each command. They also apply to CLI comments and commands forwarded by a [router](#routing). The engine gives a reason when it refuses an unknown, disabled or unauthorized command. <!-- code: src/workflow.ts#CommandSettings src/workflow.ts#pickCommandTarget src/run/trigger.ts#tick -->

Commands prefer a work run over a router. A restart keeps the answers and reuses the branch unless its pull request closed without merging. In that case the new branch name ends in a number. <!-- code: src/workflow.ts#pickCommandTarget src/run/trigger.ts#tick src/run/hear.ts#readEarlierBranch src/run/drive.ts#runWorkflow -->

## What a live run hears

In a workflow's `on` map, `comment`, `approved`, `changes_requested` and `merged` describe what trusted events do to an existing run. This example treats comments and requested changes as answers. <!-- code: src/workflow.ts#getHeard src/event.ts#HeardKinds -->

```yaml
on: { issues: { label: agent:ready }, comment: answer, changes_requested: answer }
```

Choose `answer` to deliver text, `back` to return to a step, `pass` to advance, `stop` to end the run or `none` to ignore the event. By default a marked comment answers. At a human wait, approval, the `approved` label or a merge passes, and requested changes can send work back. Outside a human wait the engine ignores `pass` and `back` overrides and uses the usual outcome. Commands, issue closure, removal of the trigger label and changes to limit labels have their own rules. <!-- code: src/workflow.ts#getHeard src/workflow.ts#getEventOutcome src/workflow.ts#transition -->

With `comment: answer`, a trusted person can wake the run on the issue or its pull request without typing `/agent`. The prompt asks the agent to leave a comment meant for someone else alone. A review sent as an answer includes its body and line comments. Bot comments do not wake the run. Use an [event hook](plugins.md#event-hooks) for rules that depend on the person or issue. <!-- code: src/workflow.ts#unmarkedNote src/workflow.ts#getEventOutcome src/run/hear.ts#readHeard src/run/trigger.ts#tick -->

## Routing

A router is a comment workflow with a step granted the `tell` proposal. It can run alongside a work run. When a graph has a router, only comment workflows hear plain `/agent` requests directly. An unmarked comment for a work run configured with `comment: answer` starts the router. <!-- code: src/run/hear.ts#findRouter src/run/hear.ts#isRouted src/run/trigger.ts#tick -->

A router uses `tell` to forward feedback, answers or commands. The engine looks for a work run before a feedback run. If it finds no recipient, the try fails. The recipient's [trace](runs.md#the-trace) records the forwarded text. <!-- code: src/run/start.ts#findRecipient src/run/attempt.ts#runAttempt src/run/hear.ts#readRunEvents -->

## Project boards

The engine checks board columns each pass. If it cannot read a board, it reports the problem and other triggers still work. See [trigger fields](reference.md#workflows), [credentials](github.md#project-boards) and [board writes](plugins.md#status-hooks). <!-- code: src/github.ts#githubTracker src/github.ts#readProjectToken src/run/trigger.ts#tick -->

## Trust and scope

The GitHub tracker uses the [instance trust list](local.md#named-instances-and-settings) when set. Otherwise it trusts owners, members and collaborators. Label changes also require write access. The tracker withholds untrusted text, and graph settings cannot set `trust`. <!-- code: src/github.ts#githubTracker src/settings.ts#getSettings src/folder.ts#GraphSettings -->

Bot comments do not start work. When the engine files an `XL` part, it starts the filing run's workflow on that part if it is less than three levels deep. The `milestone` setting restricts which issues can start runs. See [filing issues](proposals.md#filing-issues). <!-- code: src/run/start.ts#createIssues src/run/hear.ts#isInScope src/run/trigger.ts#tick -->

## Dispatch

A person can [dispatch](cli.md#verbs) any workflow onto an open, in-scope issue with no live run. A pull request cannot be the target. The optional text becomes the request and appears in the trace as a [spoken event](runs.md#the-trace). <!-- code: src/run/trigger.ts#instruct src/run/start.ts#findUndispatchable -->

An agent or script can propose one `run` per try. The step needs that grant and the target workflow needs `on: dispatch`. Script steps get the grant by default unless they set `returns`. The optional `step` selects where the child begins. The parent waits until the child asks, awaits review, finishes or stops. It then receives the child's outcome as an answer and repeats its step. <!-- code: src/workflow.ts#compileWorkflow src/run/start.ts#startProposedRun src/run/start.ts#findUndispatchable src/run/start.ts#formatSettled src/run/trigger.ts#tick -->

## The session

The session uses the agent's instructions as its system prompt. Its turn prompt combines skills, workflow text, issue and pull request context, feedback, checks and allowed proposals. A fresh session at a step with `back` also receives the branch diff unless the step splits work with `each`. Set `carry` to forward the successful reply, without its proposal block, to the next step. Otherwise the next step starts without that reply. <!-- code: src/run/execute.ts#makeAgentSessionSpec src/context.ts#context src/run/attempt.ts#runAttempt src/workflow.ts#transition -->

Issue news is the text of recent events. During a session, the engine updates `/news/news.md` every minute. A resumed session gets feedback, changed context and the path to that file. <!-- code: src/context.ts#news src/sandbox.ts#inside src/run/attempt.ts#runAttempt -->

## Tries and going back

A try is one attempt at a step. A failed check or refused proposal sends its findings back for the next try. When the step exhausts `tries`, the run asks how to continue. The `back` field names a step to return to with a reason. An agent step with `back` must state its goal in `until`. Each return counts as a round, and `rounds` caps those returns. See [session policies](reference.md#sessions). <!-- code: src/workflow.ts#transition src/workflow.ts#compileWorkflow -->

For a workflow with a branch, a try granted `push` fails on an empty diff unless it asks, proposes `back` or files an `issue`. The empty-diff rule does not apply when the issue is a pull request, the run has an open pull request, or the same workflow already has a `done` run on the issue. <!-- code: src/run/attempt.ts#runAttempt src/run/attempt.ts#pickTryOutcome src/workflow.ts#unchanged -->

## Waiting

A run can wait at a human step, ask a question with `ask`, or exhaust its tries or rounds. The engine posts its question on the issue or, once open, the pull request. A person's `/agent` reply stays paired with its question for later steps and checks. A reply after the final allowed round grants one more round. A stop command or issue closure ends the run. <!-- code: src/context.ts#proposeQuestion src/workflow.ts#transition src/workflow.ts#getEventOutcome src/run/check.ts#formatAnswers -->

## Asides

An aside is a side session for a reply at a human wait with an open pull request. It uses a throwaway checkout of the pull request head. It forks the session from the `back` target or starts fresh with the thread. The engine discards its edits. A granted `comment` replies and keeps the run waiting. A granted `back` resumes work. An empty proposal list leaves the run waiting without a reply. Without an open pull request, the engine can send feedback directly back to work. <!-- code: src/run/follow.ts#runAside src/run/trigger.ts#tick -->

## Comments while it works

The `concurrency` setting controls how the engine delivers trusted comments while an agent works. <!-- code: src/workflow.ts#Front src/run/attempt.ts#runAttempt -->

| Setting | What happens to the reply |
| --- | --- |
| `steer` | The session receives news. If it finishes before seeing the reply, it gets another turn. |
| `queue` | The engine delivers the reply after the try and its checks. |
| `cancel` | The engine interrupts the session and resumes with feedback. The interrupted try does not count. |

<!-- code: src/run/attempt.ts#runAttempt -->

The engine combines consecutive answers and gives the first command priority. When polling for events, the loop waits for 30 quiet seconds before starting or waking a run on the issue. <!-- code: src/workflow.ts#fold src/run/hear.ts#readHeardOutcome src/run/trigger.ts#tick src/run/trigger.ts#issueDebounceMs -->

## Engine errors

For most engine errors the run retries immediately. A second consecutive failure parks the run with `waiting.on` set to `engine`. A host error, such as a missing image, parks it immediately. A rejected login stops the run. A timeout sends it to its [time limit](#limits-on-an-issue). <!-- code: src/run/drive.ts#runWorkflow src/run/settle.ts#isParked src/docker.ts#dockerRunner -->

The engine retries a parked run automatically up to five times. The delays are 10, 20, 40, 80 and 160 minutes, each measured from the run's last move. A reply or `agi resume --parked` can also resume work, including a parked feedback or conflict workflow. <!-- code: src/run/trigger.ts#tick src/run/trigger.ts#instruct src/run/trigger.ts#isEngineRetryDue -->

## When the base or the graph moves

The base is the branch the work starts from. With an open pull request, a workflow can follow changes to that branch by merging or rebasing them. This update and its checks are called catch-up. Configure [`follow`, `checks` and `conflict`](reference.md#steps) at a human wait. <!-- code: src/run/follow.ts#runCatchUp src/workflow.ts#compileWorkflow -->

Runs at human waits and completed runs with open pull requests can check again. Scripts run before judges. When the work or graph changes, the engine runs all checks on the `back` target. A failure can reopen a completed run. A run waiting on a question only follows the base and receives the changes as feedback. Graph hashes include settings, prompts, scripts and plugins. <!-- code: src/run/trigger.ts#tick src/run/follow.ts#runCatchUp src/folder.ts#loadGraph -->

Judges receive the base's commits and diff, issues and pull requests named as `#N` in the commits, and issues those pull requests close. Scripts receive the old base in `AGENTGRAPH_FROM`. Feedback includes what changed. The engine remembers the commit range until checks finish. <!-- code: src/run/follow.ts#readBaseGain src/run/follow.ts#runCatchUp src/run/checkout.ts#findFanOutItems -->

On a conflict, `back` supplies a checkout with conflict markers. A try that proposes a push with markers fails. A named `on: conflict` workflow can handle the conflict. With `ask`, or after a second conflict at the same base, the engine asks for a manual update. A failed catch-up waits for the base, branch or graph to change before it retries. Parked runs and superseded runs skip catch-up. <!-- code: src/run/follow.ts#moveCheckoutOnto src/run/attempt.ts#pickTryOutcome src/run/follow.ts#runCatchUp src/run/trigger.ts#tick -->

### Stacked and dependent issues

For workflows with a branch, an open [dependency](proposals.md#stacks-on-and-depends-on) prevents work from starting. The run stays `running` with a reason until the dependency closes. With `stacks: true`, a child can build on a parent's pull request. It waits for the parent to open that pull request, then targets its branch. A merged parent lets a new child start on the configured base. A parent that closes without merging keeps the child waiting. GitHub registers the stack where supported. <!-- code: src/run/trigger.ts#findHold src/run/trigger.ts#isWorkLanded src/run/drive.ts#findStackBase src/github.ts#githubTracker -->

A stacked child follows its parent without running checks. It rebases from the branch fork when the parent's head changes. If a rebase conflicts, a waiting run asks once for that parent head and branch tip. If the tracker reports that the branch moved, the engine tries up to three times before waiting for a new tip. When the parent merges, the child follows the parent's base and retargets its pull request. Catch-up handles remaining conflicts. <!-- code: src/run/follow.ts#runFollow src/run/follow.ts#runCatchUp src/run/trigger.ts#tick -->

## Status on the issue

Run states are `running`, `waiting`, `done` and `stopped`. For the issue status, a question takes priority over review, then work, then the newest ended run. Quiet workflows (feedback and conflict) do not contribute. GitHub displays labels and the folder tracker moves the issue into a status folder. <!-- code: src/context.ts#findIssueStatus src/workflow.ts#isQuiet src/run/settle.ts#writeStatus src/github.ts#githubTracker src/tracker.ts#folderTracker -->

The status header moves from the issue to its pull request and preserves other body text. [Status settings](reference.md#settingsyaml) can change or hide the displayed status. Status hooks still receive changes. <!-- code: src/context.ts#formatStatusHeader src/run/settle.ts#writeStatus src/event.ts#makeBodyWithStatus src/tracker.ts#makeStatusLabel -->

| Label | Cause |
| --- | --- |
| `agent:working` | A step or child run is working. |
| `agent:needs-review` | The run waits for review on an open pull request. |
| `agent:needs-answer` | The run needs an answer, lacks a pull request at a human wait, hit a limit or encountered an engine error. |
| `agent:done` | The latest run finished. |
| `agent:stopped` | The latest run stopped. |

<!-- code: src/event.ts#issueStatuses src/context.ts#findIssueStatus src/run/settle.ts#writeStatus src/tracker.ts#makeStatusLabel -->

## Order and limits

A slot is a place in the queue for a command or session. The [settings reference](reference.md#settingsyaml) lists both caps. Queued work outside a drive takes priority, followed by the drive at the latest workflow step. The earlier start wins a tie. Router drives bypass the queue. Interrupted runs continue on the next drive. See [the loop](local.md#the-loop). <!-- code: src/run/execute.ts#makeSlots src/run/execute.ts#waitForSlot src/run/execute.ts#slotRankRef src/run/drive.ts#runWorkflow src/run/trigger.ts#runPass -->

## Limits on an issue

The labels `agent:usd-per-run:<n>` and `agent:minutes:<n>` set limits when a trusted person last added them. Duplicate limits, values that are not positive numbers, or values above `limits.max` make the run wait with a reason. To change a limit, add or replace its label on the issue. Renaming a repository label supplies no issue event. <!-- code: src/folder.ts#parseIssueLimits src/workflow.ts#findTrustedLabel src/workflow.ts#getEventOutcome -->

The engine reads the labels before setup and each try. End checks, asides and base updates use the recorded limits. The time limit applies per command. Sessions, checks and [event hooks](plugins.md#event-hooks) all count toward `usd-per-run`. Reaching the budget or timing out makes the run wait with instructions. Quiet workflows stop instead. <!-- code: src/run/drive.ts#runWorkflow src/folder.ts#makeRunGraph src/trace.ts#getRunSpend src/workflow.ts#transition -->

A trusted limit-label change or `/agent` lets the engine check again. The run keeps its spend, sessions and feedback. After a timeout, raise `minutes` to continue. <!-- code: src/workflow.ts#getEventOutcome src/workflow.ts#transition src/run/drive.ts#runWorkflow -->

## Retros

A retro is a run of a workflow with `on: feedback`. It reads recent settled work and trusted comments, reviews or commits on the issue. Set `restarts: true` to include runs stopped by a restart. Outsider text stays withheld. A router, another retro, a run that ended over a day ago or a run that is only waiting does not by itself start one. <!-- code: src/run/trigger.ts#feedback src/run/trigger.ts#tick src/run/hear.ts#findSettledRuns src/run/hear.ts#readIssueWithPull -->

Retros skip setup, leave issue status alone and let other work proceed. They can file graph or follow-up issues. They stop where a work run would ask a person. The studio and `agi show` display problems. <!-- code: src/run/drive.ts#runWorkflow src/run/trigger.ts#tick src/workflow.ts#transition src/run/settle.ts#writeStatus src/status.ts -->
