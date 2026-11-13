# Workflows

Workflows run ordered steps on issues. [Reference](reference.md#workflows) lists their fields.

## Steps

Define `workflows/<name>.md`:

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

`steps` run in order: `agent`, `run` or `wait: human`. Without `steps`, the body prompts one agent step. See [skill defaults](reference.md#steps).

### Gates

A `run` step passes on exit 0. Fenced proposals need [`returns` grants](proposals.md#kinds). An ungranted kind fails the try without applying proposals.

Conditional `run` proposals start children; parents wait, then repeat the step. See [trace access](checks.md#reading-traces). <!-- code: src/graph.ts#getStepReturns --> <!-- code: src/run/attempt.ts#runAttempt src/workflow.ts#compileWorkflow -->

## What starts a run

- `issue_comment`: a trusted comment contains `/agent` or `@agent` outside quotes and code.
- `issues.label`: a trusted person adds the configured label to an open issue.
- `issues.column`: an open issue enters the configured Status column.

Runs also start through human or [agent dispatch](#dispatch), [retros](#retros) and [conflict handling](#when-the-base-or-the-graph-moves). `pull_request` and `branches` start nothing.

`/agent` selects the first comment workflow. Unmarked comments supply context; pull request comments belong to their issue. Taken comments retain eyes reactions.

A label starts its workflow once per issue; restart starts it again. One work run holds the issue. Removing its trigger label stops it. <!-- code: src/workflow.ts#isIssueTriggered --> <!-- code: src/run/trigger.ts#instruct --> <!-- code: src/workflow.ts#Front --> <!-- code: src/run/trigger.ts#tick -->

### Commands

`/agent <text>` supplies text; colons join commands:

| Command | Effect |
| --- | --- |
| `/agent:stop [reason]` | End run |
| `/agent:cancel` | Park step; ask |
| `/agent:restart` | Restart newest workflow |
| `/agent:restart:<step>` | Restart from step |
| `/agent:<workflow> [text]` | Start or answer |
| `/agent:<workflow>:stop [reason]` | End named run |
| `/agent:<workflow>:cancel` | Park named step; ask |
| `/agent:<workflow>:restart[:<step>]` | Restart named workflow |

[`commands`](reference.md#settingsyaml) gates trusted users, including CLI comments and router `tell`. Unknown, disabled or unauthorized commands do nothing, with reasons. <!-- code: src/workflow.ts#pickCommandTarget src/workflow.ts#CommandSettings -->

Commands prefer work over routers. Restart retains answers and branch, except closed unmerged pull requests get suffixed branches. `stop`, `cancel`, `restart` are reserved names. <!-- code: src/workflow.ts#pickCommandTarget src/workflow.ts#commandVerbs src/tracker.ts#makeCommentWithAgentRequest --> <!-- code: src/run/drive.ts#runWorkflow src/run/hear.ts#readEarlierBranch src/run/attempt.ts#pickTryOutcome --> <!-- code: src/run/trigger.ts#tick src/workflow.ts#compileWorkflow src/workflow.ts#commandVerbs src/folder.ts#compile -->

An answer-only request needs no code change. Otherwise, a first session granted `push` fails if it changes nothing. <!-- code: src/context.ts#formatRequest src/run/attempt.ts#pickTryOutcome --> <!-- code: src/workflow.ts#getEventOutcome -->

## Project boards

Column triggers poll each pass. `project` selects a board; otherwise only the repository owner's boards count. Either `label` or `column` can trigger work; the column also adds the configured label. Leaving the column does not stop work. <!-- code: src/github.ts#githubTracker src/run/trigger.ts#tick --> <!-- code: src/workflow.ts#issueSources --> <!-- code: src/run/trigger.ts#tick -->

Missing access is reported; other triggers work. See [credentials](github.md#project-boards) and [board writes](plugins.md#status-hooks). <!-- code: src/github.ts#readProjectToken --> <!-- code: tests/fixtures/triggers/plugins/board.ts src/github.ts#githubTracker -->

## Trust and scope

[Instance trust](local.md#named-instances-and-settings) covers owners, members and collaborators; label actors need write access. Graphs reject `trust`. Outsider text is withheld; invalid graphs trust nobody. <!-- code: src/github.ts#githubTracker src/settings.ts#getSettings src/harnesses.ts#readOverrides src/settings.ts#InstanceFile src/folder.ts#GraphSettings -->

Bots start nothing except engine-filed `XL` parts restarting triage. `milestone` scopes new runs. See [label restrictions](proposals.md#kinds). <!-- code: src/run/check.ts#runStepChecks src/run/hear.ts#isInScope -->

## Dispatch

Human [`dispatch`](cli.md#verbs) needs an open, in-scope issue without live runs. Text becomes the request, recorded as [`spoken`](runs.md#the-trace). Agents granted `run` need `on: dispatch`. <!-- code: src/run/trigger.ts#instruct src/context.ts#formatRequest -->

Optional `step` selects the starting step. Each try allows one `run` proposal. The parent waits until the child asks, awaits review, finishes or stops, then receives its outcome as an answer. <!-- code: src/run/start.ts#findUndispatchable src/run/start.ts#startProposedRun src/run/start.ts#formatSettled -->

### Routing

An `issue_comment` workflow whose agent has `tell` acts as a router beside work runs. When a router exists, only comment workflows hear `/agent` directly; others receive forwarded text. <!-- code: src/run/hear.ts#getHeardEvent -->

`tell` delivers maintainer feedback, answers or commands. Work precedes retros; missing recipients fail. See [`told` records](runs.md#the-trace). <!-- code: src/run/start.ts#findRecipient src/run/hear.ts#readRunEvents src/run/trigger.ts#tick -->

## The session

Prompts combine agent instructions, skills, workflow text, issue and pull request context, feedback, checks and grants. Fresh steps with `back` also receive the branch diff. <!-- code: src/context.ts#context -->

Issue news updates `/news/news.md` every minute. Resumes receive feedback, changed context and its path. <!-- code: src/context.ts#news src/sandbox.ts#inside -->

## Tries and going back

`carry` forwards successful replies without proposal blocks; otherwise replies are omitted. <!-- code: src/run/trigger.ts#tick src/workflow.ts#transition src/workflow.ts#StepFile -->

Failed checks or proposals retry with findings. Exhausted `tries` make the run wait. `back` returns with a reason; agent steps with `back` require `until`. `rounds` caps returns. See [session policies and resume fallback](reference.md#sessions). <!-- code: src/workflow.ts#transition --> <!-- code: src/workflow.ts#compileWorkflow src/workflow.ts#transition -->

At `wait: human` with `back`, requested changes return to work. Approval, the `approved` label or merge passes the wait. Other comments use asides. <!-- code: src/workflow.ts#getEventOutcome -->

## Waiting

Runs wait at human steps, on `ask` or after exhausting `tries` or `rounds`. Questions go to the issue, then its pull request once available. `/agent` answers stay paired with questions for steps and checks. A reply after exhausted rounds grants one more. A stop command or issue closure ends the run. <!-- code: src/run/check.ts#formatAnswers src/context.ts#proposeQuestion -->

## Limits on an issue

`agent:usd-per-run:<n>` and `agent:minutes:<n>` apply when their last label event came from a trusted person. Duplicate limits, values that are not numbers above 0, or values above `limits.max` make the run wait with a reason. Values are never clamped. <!-- code: src/folder.ts#parseIssueLimits src/workflow.ts#findTrustedLabel src/run/check.ts#runStepChecks -->

The engine reads labels before setup and every try. End checks, asides, follows and catch-ups use recorded `limits`. `minutes` limits each command. <!-- code: src/run/drive.ts#runWorkflow src/folder.ts#makeRunGraph -->

Session and check costs count toward `usd-per-run`. Reaching it or timing out makes the run wait with instructions. <!-- code: src/run/settle.ts#readRunSpend src/trace.ts#getRunSpend src/run/drive.ts#runWorkflow --> <!-- code: src/folder.ts#formatLimitRaise src/context.ts#proposeQuestion -->

Trusted limit-label changes or `/agent` resume the run with spend, sessions and feedback retained. Limits are checked before sessions; timeouts require higher `minutes`. Retros and conflict follows stop instead. Add a label to change a limit; repository label renames produce no issue events. <!-- code: src/workflow.ts#getEventOutcome src/workflow.ts#transition -->

## Asides

At human waits, asides use throwaway checkouts of the pull request head. They fork the `back` target's session or start fresh with the thread. Edits are discarded. Only granted `comment` and `back` proposals apply: `comment` keeps waiting; `back` resumes work. Without an open pull request, feedback returns directly to work. <!-- code: src/run/follow.ts#runAside -->

## Comments while it works

`concurrency` handles trusted comments:

- `steer`: deliver through news; missed comments get another turn.
- `queue`: apply the answer after the try and checks.
- `cancel`: interrupt and resume with feedback; interrupted tries do not count. <!-- code: src/run/attempt.ts#runAttempt -->

`/agent:cancel` parks the step; `/agent:stop` ends the run. Consecutive comments combine; the first command wins. Starts and wakeups need 30 quiet seconds. <!-- code: src/workflow.ts#getEventOutcome src/workflow.ts#fold src/run/trigger.ts#issueDebounceMs src/run/hear.ts#readHeardOutcome -->

## When the base or the graph moves

Human waits configure [`follow`, `checks`, `conflict`](reference.md#steps). <!-- code: src/workflow.ts#Step src/run/follow.ts#runCatchUp -->

Runs at human waits and done runs with open pull requests follow and check. Scripts precede judges. Changed work or graphs use all `back` checks; failures return to work, reopening done runs. Runs waiting on questions only follow; their next session hears what the base gained. [Stacks](proposals.md#stacks-on-and-depends-on) follow parents without checks. Graph hashes cover settings, prompts, scripts and plugins. <!-- code: src/run/trigger.ts#tick --> <!-- code: src/run/follow.ts#runFollow src/types.ts#Run --> <!-- code: src/run/follow.ts#runCatchUp src/folder.ts#loadGraph -->

The base's gains include commits, the diff, issues and pull requests named as `#N` in merged commits, and issues those pull requests close. Judges receive these with the change's diff; scripts get the old base as `AGENTGRAPH_FROM`. Return feedback includes the gains. The followed range stays until checks decide, so each base head is checked once. <!-- code: src/run/follow.ts#readBaseGain src/run/checkout.ts#findFanOutItems -->

On conflict, `back` supplies a checkout with conflict markers; leftover markers fail the try. A named `on: conflict` workflow handles them quietly. `ask` or a second conflict at the same base requests a manual update. <!-- code: src/run/follow.ts#moveCheckoutOnto src/run/drive.ts#runWorkflow -->

Catch-up errors retry after the base, branch or graph changes. Refused stacked follows retry three times, then await a branch tip change. Parked runs and older restarts never catch up. <!-- code: src/run/follow.ts#runCatchUp src/workflow.ts#isQuiet -->

## Status on the issue

Run states are `running`, `waiting`, `done` and `stopped`. Issue status takes the first available: question, review, work, newest ended run. Quiet runs contribute nothing. GitHub shows labels; the folder tracker moves issues into status folders. <!-- code: src/github.ts#githubTracker src/tracker.ts#folderTracker --> <!-- code: src/context.ts#findIssueStatus src/run/settle.ts#announce -->

Status headers move from the issue to its pull request and track status changes, preserving other body text. See [spend records](runs.md#runjson). <!-- code: src/context.ts#formatStatusHeader --> <!-- code: src/context.ts#formatStatusHeader src/run/settle.ts#writeStatus src/event.ts#makeBodyWithStatus -->

[`status` mappings](reference.md#settingsyaml) rename/disable display; hooks still fire. <!-- code: src/folder.ts#GraphSettings src/tracker.ts#makeStatusLabel -->

| Label | Cause |
| --- | --- |
| `agent:working` | Step or child running |
| `agent:needs-review` | Human wait with pull request |
| `agent:needs-answer` | Question, no pull request, limits or engine error |
| `agent:done` | Latest run finished |
| `agent:stopped` | Latest run stopped |

<!-- code: src/event.ts#issueStatuses src/context.ts#findIssueStatus src/run/settle.ts#writeStatus src/tracker.ts#makeStatusLabel --> <!-- code: src/context.ts#proposeQuestion -->

## Order and limits

`limits.parallel` caps drives, including end checks. `limits.sessions` caps instance sessions and scripts, including judges. `agi loop --parallel <n>` caps drives across instances. Routers use neither slot. See [limits](reference.md#settingsyaml). <!-- code: src/run/trigger.ts#tick src/run/trigger.ts#runPass src/run/execute.ts#sessionPermitsRef -->

Loops poll; folder edits trigger scans. Background drives run oldest first under run locks. Interrupted runs resume on the next drive. `agi start` and `loop --once` run in the foreground. See [loop controls](local.md#starting-and-stopping-a-loop). <!-- code: bin/run.ts#serve src/main.ts#start src/run/trigger.ts#scanTrackerEvents --> <!-- code: src/run/trigger.ts#scanTrackerEvents src/run/trigger.ts#scanIssuesAndRunningRuns --> <!-- code: src/run/trigger.ts#runPass src/run/trigger.ts#startLoopDrives src/main.ts#start --> <!-- code: src/run/trigger.ts#runPass -->

Engine errors retry once, then park visibly; missing images park immediately. Rejected credentials stop. Replies or `resume --parked` retry, including quiet runs. <!-- code: src/run/drive.ts#runWorkflow src/run/attempt.ts#runAttempt src/main.ts#start --> <!-- code: src/run/drive.ts#runWorkflow src/context.ts#proposeQuestion -->

## Retros

`on: feedback` starts retros on trusted comments, reviews, commits and ended work runs. Outsider text remains withheld. Restarts need `restarts: true`. <!-- code: src/run/trigger.ts#feedback src/run/hear.ts#findSettledRuns --> <!-- code: src/run/hear.ts#readIssueWithPull -->

Feedback is batched after 30 quiet seconds. Routers, retros, runs ended over a day ago and waiting alone trigger none. <!-- code: src/run/trigger.ts#feedback src/run/trigger.ts#issueDebounceMs --> <!-- code: src/run/hear.ts#findSettledRuns -->

Retros skip setup, never hold issues or change status, and post no comments. They stop where ordinary runs wait. They can file graph or follow-up issues. The studio and `show` expose problems. <!-- code: src/run/trigger.ts#tick src/workflow.ts#isRunDone --> <!-- code: src/workflow.ts#transition -->
