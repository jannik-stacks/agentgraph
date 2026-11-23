# Types and schemas

Effect schemas decode files and messages written by people or other processes, and `typeof X.Type` gives the TypeScript type of the decoded data. Values that stay in memory can use plain TypeScript types, such as the compiled `Step`. Use [Architecture](architecture.md) to follow a value through a run, [Code layout](layout.md) to locate its file, and [Conventions](patterns.md) when changing its definition. <!-- code: src/types.ts#Agent src/workflow.ts#Step STYLE.md -->

```text
Proposal member schemas --> Said --> Kind --> agent and step grants
RunFields ------------+---> Run --------> outcome and saved trace lines
                      +---> RunRecord --> ServedRun --> OpenedRun
GraphSettings ------------> Graph
Front and StepFile ---> Workflow -------> Graph.workflows
Sandbox and Checkout -----> Box
```

Derive each variant where it is used, with indexed access, `Pick`, `Omit`, `Struct.pick` or `mapFields`. A tagged union keeps fields specific to one case on that case. Look for `kind`, `type` or `on`. Trace lines use the presence of a field instead. <!-- code: src/proposal.ts#Said src/types.ts#Trace src/types.ts#Outcome src/actions.ts#OpenedRun src/workflow.ts#Step src/sandbox.ts#Box -->

## Values first

The engine's `Proposal` and the reply schema `Said` share member schemas. To restrict what an agent can request, `Said` omits the engine's `react` and `rebase` cases and derives its push member with `Push.mapFields(Struct.omit(['onto', 'merge']))`. The two issue forms share `Filed.fields`. See [proposal kinds](proposals.md#kinds) for the reply fields. <!-- code: src/proposal.ts#Proposal src/proposal.ts#Said src/proposal.ts#Filed -->

`Kind` collects the distinct `kind` literals from `Said.members`. Agent and step `returns` use arrays of that schema, so a grant always names a kind a reply can contain. <!-- code: src/proposal.ts#Kind src/types.ts#Agent src/workflow.ts#StepFile -->

| Schema in `src/event.ts` | Meaning |
| --- | --- |
| `Count` | A positive integer, used for issue numbers. |
| `Issue` | An issue or pull request in state `open`, `closed` or `merged`. A pull request adds `pull` with `branch`, `base`, `head` and optional `baseSha`. |
| `Comment` | A comment can include a parsed `agentRequest`. `findRequest` finds a mark outside block quotes and fenced code, and `parseAgentRequest` separates the optional command from the text. |
| `Event` | One timeline entry has `actor`, `bot`, `trusted` and `at` fields. Its `kind` is `comment`, `approved`, `changes_requested`, `review_requested`, `merged`, `closed`, `label`, `unlabel`, `column`, `commit` or `check`. The engine consumes the tracker's trust decision. |
| `Applied` | `Tracker.apply` returns a proposal with an `ok` flag. Its result can include `url`, `reason`, paths withheld from a push in `held`, and the `moved` flag. The engine can include an `operation` key when it records the result in the trace. |
| `Heard` | A live run can hear an event as `answer`, `back`, `pass`, `stop` or `none`. `HeardKinds` maps configurable event kinds to those decisions. `heardKinds` comes from `Struct.keys(HeardKinds.fields)`. |

<!-- code: src/event.ts#Count src/event.ts#Issue src/event.ts#Event src/event.ts#Comment src/event.ts#findRequest src/event.ts#parseAgentRequest src/event.ts#Applied src/event.ts#Heard src/event.ts#HeardKinds src/event.ts#heardKinds src/tracker.ts#Tracker src/run/settle.ts#writeAppliedTrace -->

In `src/result.ts`, `CheckMode` accepts `info`, `warn`, `block` and `stop`. `ResultType` describes the JSON Schema subset shared by `returns` and `pass`. `findMismatch` checks a value against it. `defaultReturns` and `defaultPass` define the usual result and passing condition. The `PluginMetadata` schema in `src/meta.ts` validates the JSON a plugin or importer attaches as `meta`. <!-- code: src/result.ts#CheckMode src/result.ts#ResultType src/result.ts#defaultReturns src/result.ts#defaultPass src/result.ts#findMismatch src/meta.ts#PluginMetadata -->

## Run and RunRecord

The `Run` and `RunRecord` schemas in `src/types.ts` share a private field map, `RunFields`. The engine drives a `Run` for one issue. The store accepts a `RunRecord` even when an import has no issue number. <!-- code: src/types.ts#RunFields src/types.ts#Run src/types.ts#RunRecord -->

```ts
export const Run = Schema.Struct({ ...RunFields, issue: Count });
export type Run = Types.Mutable<typeof Run.Type>;
// ...
export const RunRecord = Schema.Struct({ ...RunFields, issue: Schema.optionalKey(Count) });
export type RunRecord = Types.Mutable<typeof RunRecord.Type>;
```

`isOnIssue` narrows a record to a run with an issue. `get` and `list` return only runs on issues. Use `getRecord` and `listRecords` to include imports. <!-- code: src/graph.ts#isOnIssue src/store.ts#Store src/types.ts#InstanceHost -->

A run is `running`, `waiting`, `done` or `stopped`. `isRunDone` recognizes the last two. A waiting run without a `waiting` field needs a person. Otherwise `waiting.on` identifies the cause. A `run` wait carries a child run ID, an `engine` wait can name a `SandboxError`, `SessionStop` or `TrackerError`, and a `limits` wait explains the limit in `why`. `isWaitingOnPeople` includes limit waits because a person can raise the limit. `formatReason` supplies the display text. <!-- code: src/types.ts#Waiting src/types.ts#RunFields src/types.ts#isWaitingOnPeople src/types.ts#formatReason src/workflow.ts#isRunDone -->

See [run.json](runs.md#runjson) for the stored fields.

## Outcome

One try or incoming event produces an `Outcome`, a schema tagged on `kind`. A `pass` advances the run. A `failed` outcome carries `checks`, `proposals` and `problems`. A `back` or `stop` explains `why`. An `ask` has a `question` and optional `waiting` condition. An `answer` carries `text`. Two pure functions in `src/workflow.ts` own step selection. The first, `begin`, creates the initial run. After that, `transition(workflow, run, outcome)` returns the updated run. <!-- code: src/types.ts#Outcome src/workflow.ts#transition src/workflow.ts#begin -->

`CheckResult` names the `check` and records its `pass` verdict and duration in `ms`. It can carry a structured `value`, the passing fraction (`share`) and `findings`. The `empty` flag means the check produced no usable measurement. The `na` flag means the check did not apply. A `CheckEntry` in `checks.jsonl` pairs that result with the line's time and step, the check version and cost, and optional details such as the item, output log or `later` flag. <!-- code: src/types.ts#CheckResult src/types.ts#CheckEntry src/run/check.ts#runOneCheck src/run/evaluate.ts#runEndedChecks -->

## Trace lines

Each of the thirteen trace shapes shares `Line` (`at` and `step`) and has one distinguishing key. Readers can narrow the union with `'outcome' in line`. See [The trace](runs.md#the-trace) for the on-disk record. <!-- code: src/types.ts#Trace src/types.ts#Line -->

Session lines come from `openSession`. The drive and tracker tick write outcomes, and the store writes field changes when it saves a snapshot. <!-- code: src/run/execute.ts#openSession src/run/drive.ts#runWorkflow src/run/trigger.ts#tick src/store.ts#fileStore -->

The `outcome` line records only the fields needed to reconstruct step changes. The `saved` line uses `Run.mapFields(Struct.map(Schema.optionalKey))` so it can record any subset. The array of cleared keys draws its element type from `Schema.Literals(Struct.keys(Run.fields))`. <!-- code: src/types.ts#Trace src/trace.ts#makeOutcomeLine -->

```ts
    run: Run.mapFields(Struct.pick(['step', 'status', 'tries', 'rounds', 'reason', 'waiting'])),
```

A session opens with a `SessionSpec`. Its `harness`, `model`, `system`, `prompt`, `dir`, `tools`, `returns` and `minutes` describe the work. The spec can also request a `resume` or `fork`, or provide an `mcp` tool connection. The harness streams `SessionEvent` values tagged by `type` as `start`, `text`, `thinking`, `tool`, `usage` or `end`. A `SessionStop` identifies a `timeout`, `stalled`, `budget`, `provider`, `login`, `human` or `sandbox` failure. <!-- code: src/types.ts#SessionSpec src/types.ts#SessionEvent src/types.ts#SessionStop -->

## Graph files and the compiled graph

| Input | Schema and source file | In memory |
| --- | --- | --- |
| `settings.yaml` | `GraphSettings` in `src/folder.ts` | Settings on the compiled `Graph` |
| `agents/<name>.md` | `Agent` in `src/types.ts` | A `Doc<Agent>` in the agents map |
| `skills/<name>.md` or `skills/<name>/SKILL.md` | `SkillFile` in `src/folder.ts` | A `Doc<SkillFile>` in the skills map |
| `checks/<name>.md` | `Check` in `src/types.ts` | A `Doc<Check>` with a version hash |
| `workflows/<name>.md` | `Front` with a `StepFile` per step in `src/workflow.ts` | A `Workflow` with ordered steps |
| `instance.yaml` alongside the instance data | `InstanceFile` in `src/settings.ts` | An `Instance` from `src/instance.ts` |

<!-- code: src/folder.ts#GraphSettings src/folder.ts#loadGraph src/types.ts#Agent src/folder.ts#SkillFile src/types.ts#Check src/workflow.ts#Front src/workflow.ts#StepFile src/settings.ts#InstanceFile src/instance.ts#Instance -->

`Doc<T>` adds a name, path and Markdown body to the decoded frontmatter. `loadGraph` collects validation problems so a `GraphError` can report their paths and messages together. The compiled graph takes its settings from the file schema and adds the checkout-specific data and four maps. <!-- code: src/workflow.ts#Doc src/workflow.ts#Problem src/folder.ts#GraphError src/folder.ts#loadGraph src/folder.ts#Graph -->

```ts
export type Graph = Omit<typeof GraphSettings.Type, 'auth'> & {
  dir: string;
  repo: string;
  sha: string;
  // ...
  agents: Record<string, Doc<Agent> & { readonly?: true; package?: string }>;
  skills: Record<string, Doc<SkillFile>>;
  checks: Record<string, Doc<Check> & { version: string }>;
  workflows: Record<string, Workflow>;
};
```

The `StepFile` schema accepts the flat fields in the [step reference](reference.md#steps). `compileWorkflow` validates their combinations and returns problems with paths. In the compiled `Step`, the `does` union identifies one action and `back` groups the target, condition and round limit. <!-- code: src/workflow.ts#StepFile src/workflow.ts#Step src/workflow.ts#compileWorkflow -->

```ts
export type Step = {
  name: string;
  does:
    | { agent: string; skill?: string }
    | { run: string; returns: NonNullable<(typeof StepFile.Type)['returns']>; reads?: 'traces' }
    | { wait: 'human' };
  // ...
  back?: { to: string; until?: string; rounds?: number };
  each?: string;
};
```

`Workflow.on` combines a partial record over `issues`, `issue_comment`, `pull_request`, `dispatch`, `feedback` and `conflict` with `typeof HeardKinds.Type`. That gives live events the same keys in the workflow and in the event schema. In `src/graph.ts`, `makeWorkflowGraph` builds a `WorkflowGraph` for the studio's graph page. Its nodes and edges show the steps and their paths. Its `worst` estimate counts agent-step tries and bounded returns. <!-- code: src/workflow.ts#Workflow src/event.ts#HeardKinds src/graph.ts#WorkflowGraph src/graph.ts#makeWorkflowGraph studio/src/graph/GraphPage.tsx studio/src/graph/StepDetails.tsx -->

`Limits` spreads `CommandLimits.fields` for `memory` and `cpus`. `Schema.encodeKeys` spells the spend field `usd-per-run` in graph settings. `makeRunGraph` overlays the run's limits. <!-- code: src/folder.ts#Limits src/types.ts#CommandLimits src/folder.ts#makeRunGraph -->

`InstanceFile` reuses `GraphSettings.fields.image`. In `getSettings`, flags win. Image and parallelism then use instance settings before graph settings. Trust falls back to the instance trust list or owner. The repository falls back to the instance repository or an empty string. For the base, the workflow takes precedence over the instance. <!-- code: src/settings.ts#InstanceFile src/settings.ts#getSettings -->

## Host seams

The engine’s `Services` type is the union `Tracker | Store | Session | Sandbox`. Each service extends `Context.Service` with a record of operations. <!-- code: src/run/execute.ts#Services src/tracker.ts#Tracker src/store.ts#Store src/sandbox.ts#Sandbox src/session.ts#Session -->

In `src/tracker.ts`, `Tracker` extends the `issues`, `issue` and `since` reads of `InstanceHost['tracker']` with `base`, `searchIssues`, `apply` and `findPost`. Its optional members are `status`, `writeStatusHeader`, `slug`, `writeField` and `studio`. Applying a proposal can fail with a `TrackerError`. <!-- code: src/tracker.ts#Tracker src/types.ts#InstanceHost src/types.ts#TrackerError -->

```ts
    apply: (number: number, proposal: Proposal, work?: Checkout) => Effect.Effect<Applied, TrackerError>;
```

The studio and its plugin pages receive `InstanceHost`, a plain read-only TypeScript type defined in `src/types.ts`. Its store exposes `getRecord`, `list`, `listRecords`, `read`, `readChecks` and `readLog`. Both services reuse the host's read signatures. In `src/store.ts`, `Store` extends `InstanceHost['store']` with the three operations below plus `addChecks`, `lock`, `log`, `putFile` and `readFile`. <!-- code: src/store.ts#Store src/types.ts#InstanceHost src/types.ts#InstanceHosts src/engine.ts#makeInstanceHost -->

```ts
    get: (id: string) => Effect.Effect<Run | undefined, StoreError>;
    put: (run: RunRecord) => Effect.Effect<void, StoreError>;
    trace: (id: string, ...lines: Trace[]) => Effect.Effect<void, StoreError>;
```

In `src/sandbox.ts`, `Sandbox.checkout` produces a `Checkout` for the duration of an Effect scope. The sandbox owns git, including `readBranches`, `readHead` and `removeBranch`, and can expose a `tools` connection. Use `exec` for the result of a command or `lines` to stream its output. <!-- code: src/sandbox.ts#Sandbox src/types.ts#Checkout src/types.ts#Command src/types.ts#Exit src/mirror.ts#makeSandbox -->

```ts
    exec: (command: Command) => Effect.Effect<Exit, SandboxError, Scope.Scope>;
    lines: (command: Command) => Stream.Stream<string | Pick<Exit, 'code' | 'used'>, SandboxError, Scope.Scope>;
```

The smaller `Runner` service in the same file runs commands in the checkout. Its `open(work, graph)` operation returns a `Box` derived from the two types the sandbox already uses. <!-- code: src/sandbox.ts#Runner src/sandbox.ts#Box -->

```ts
export type Box = Pick<Sandbox['Service'], 'lines' | 'tools'> & Pick<Checkout, 'ready' | 'env' | 'written' | 'image'>;
```

In `src/session.ts`, `Session.open` returns a stream of `SessionEvent` values. A session failure ends the stream with a `SessionStop`. <!-- code: src/session.ts#Session -->

```ts
  { open: (spec: SessionSpec) => Stream.Stream<SessionEvent, SessionStop, Scope.Scope> }
```

For a studio list row, `ServedRun.run` uses `RunRecord.mapFields(Struct.pick(listedRunFields))`. To open one run, `OpenedRun` spreads `ServedRun.fields`, widens `run` to the full `RunRecord` and makes the optional `trace` required. <!-- code: src/plugin.ts#makePlugin src/plugin.ts#EventHook src/actions.ts#ServedRun src/actions.ts#OpenedRun src/actions.ts#listedRunFields -->

## Errors

These errors extend `Data.TaggedError`. A caller can use `Effect.catchTag` to handle one failure by name. <!-- code: src/run/settle.ts#writeProposals src/types.ts#TrackerError -->

| Error | File | Fields | Raised by |
| --- | --- | --- | --- |
| `TrackerError` | `types.ts` | Message, optional status and moved flag | Tracker operations |
| `StoreError` | `types.ts` | Path and cause | Store I/O |
| `SandboxError` | `sandbox.ts` | Detail and reason (timeout, stalled, infra or host) | Checkout and command operations |
| `SessionStop` | `types.ts` | Reason and optional detail | Harness sessions |
| `GraphError` | `folder.ts` | List of problems | Graph loading |
| `EachFailed` | `run/checkout.ts` | Detail | The command that lists fan-out items |

<!-- code: src/types.ts#TrackerError src/types.ts#StoreError src/sandbox.ts#SandboxError src/types.ts#SessionStop src/folder.ts#GraphError src/run/checkout.ts#EachFailed -->
