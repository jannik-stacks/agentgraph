import { Data, Effect, Formatter, type Redacted, Schema, type Stream, Struct, type Types } from 'effect';
import { Applied, Count, Event, type Issue } from './event.ts';
import { PluginMetadata } from './meta.ts';
import { Kind, Proposal } from './proposal.ts';
import { CheckMode, ResultType } from './result.ts';

const Tally = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const Agent = Schema.Struct({
  harness: Schema.String.pipe(Schema.withDecodingDefaultType(Effect.succeed(''))),
  model: Schema.optionalKey(Schema.String),
  tools: Schema.mutable(Schema.Array(Schema.String)).pipe(Schema.withDecodingDefaultType(Effect.succeed([]))),
  returns: Schema.mutable(Schema.Array(Kind)).pipe(Schema.withDecodingDefaultType(Effect.succeed(['comment']))),
  reads: Schema.optionalKey(Schema.Literal('traces')),
  session: Schema.optionalKey(Schema.Literals(['fresh', 'same'])),
});
export type Agent = typeof Agent.Type;

const ResultRoot = Schema.Struct({
  ...Struct.pick(ResultType.fields, ['properties', 'required']),
  type: Schema.optionalKey(Schema.Literal('object')),
});

export const Check = Schema.Struct({
  mode: CheckMode,
  returns: Schema.optionalKey(ResultRoot),
  pass: Schema.optionalKey(ResultRoot),
  reads: Schema.optionalKey(Schema.Literal('traces')),
  each: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty())),
  run: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  max: Schema.optionalKey(Count),
});
export type Check = typeof Check.Type;

const Text = Schema.optionalKey(Schema.String);
const Flag = Schema.optionalKey(Schema.Literal(true));
const Strings = Schema.mutable(Schema.Array(Schema.String));
const Waiting = Schema.optionalKey(
  Schema.Union([
    Schema.Struct({ on: Schema.Literal('run'), id: Schema.String }),
    Schema.Struct({
      on: Schema.Literal('engine'),
      error: Schema.optionalKey(Schema.Literals(['SandboxError', 'SessionStop', 'TrackerError'])),
    }),
    Schema.Struct({ on: Schema.Literal('limits'), why: Schema.String }),
  ])
);
const Limit = Schema.Struct({
  value: Schema.Number,
  label: Schema.optionalKey(Schema.Struct({ name: Schema.String, actor: Schema.String, at: Schema.String })),
});

export const CheckResult = Schema.Struct({
  check: Schema.String,
  pass: Schema.Boolean,
  value: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  share: Schema.optionalKey(Schema.Number),
  empty: Flag,
  na: Flag,
  findings: Text,
  ms: Schema.Number,
});
export type CheckResult = Types.Mutable<typeof CheckResult.Type>;

export const Outcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('pass'), answered: Flag, text: Text }),
  Schema.Struct({
    kind: Schema.Literal('failed'),
    checks: Schema.mutable(Schema.Array(CheckResult)),
    proposals: Schema.mutable(Schema.Array(Applied)),
    problems: Strings,
  }),
  Schema.Struct({ kind: Schema.Literal('back'), why: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('ask'), question: Schema.String, waiting: Waiting }),
  Schema.Struct({ kind: Schema.Literal('answer'), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('stop'), why: Schema.String, restarted: Flag }),
]);
export type Outcome = typeof Outcome.Type;

export const Seen = Schema.Struct({ at: Schema.String, base: Text });
export type Seen = Types.Mutable<typeof Seen.Type>;
const Kept = Schema.Struct({
  id: Schema.String,
  home: Schema.String,
  harness: Schema.optionalKey(Schema.String),
  same: Schema.optionalKey(Schema.Literal(true)),
  seen: Schema.optionalKey(Seen),
});

const RunFields = {
  meta: Schema.optionalKey(PluginMetadata),
  id: Schema.String,
  workflow: Schema.String,
  title: Text,
  body: Text,
  step: Schema.String,
  status: Schema.Literals(['running', 'waiting', 'done', 'stopped']),
  tries: Tally,
  rounds: Schema.Record(Schema.String, Tally),
  sessions: Schema.Record(Schema.String, Kept),
  judges: Schema.optionalKey(Schema.Record(Schema.String, Kept)),
  feedback: Text,
  reported: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  answers: Schema.optionalKey(
    Schema.mutable(Schema.Array(Schema.Struct({ asked: Schema.String, said: Schema.String })))
  ),
  reason: Text,
  waiting: Waiting,
  limits: Schema.optionalKey(Schema.Struct({ usdPerRun: Limit, minutes: Limit, timeout: Flag })),
  restarted: Flag,
  retried: Flag,
  seen: Text,
  said: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.Struct({ issue: Count, under: Text })))),
  eyes: Schema.optionalKey(Schema.Struct({ issue: Count, undo: Proposal.members[1] })),
  base: Schema.optionalKey(
    Schema.Struct({ pull: Count, branch: Schema.String, sha: Schema.String, from: Text, tip: Text })
  ),
  onto: Schema.optionalKey(Schema.Struct({ sha: Schema.String, merge: Flag })),
  moved: Schema.optionalKey(Schema.Struct({ from: Schema.String, onto: Schema.String })),
  graph: Text,
  graphTree: Text,
  versions: Schema.optionalKey(
    Schema.Struct({
      engine: Schema.String,
      config: Text,
      image: Text,
      harnesses: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    })
  ),
  blocked: Schema.optionalKey(Schema.Struct({ base: Schema.String, head: Schema.String, graph: Schema.String })),
  by: Text,
  checkout: Schema.optionalKey(Schema.Struct({ branch: Text, base: Schema.String })),
  startCommit: Text,
  owed: Schema.optionalKey(Strings),
  unshown: Flag,
  started: Schema.String,
  ended: Text,
};

export const Run = Schema.Struct({ ...RunFields, issue: Count });
export type Run = Types.Mutable<typeof Run.Type>;

export const Verdict = Schema.Struct({
  run: Schema.String,
  issue: Schema.optional(Count),
  at: Schema.String,
  pass: Schema.Boolean,
  empty: Schema.Boolean,
  findings: Schema.optional(Schema.String),
  items: Tally,
  failed: Tally,
});

export const RunRecord = Schema.Struct({ ...RunFields, issue: Schema.optionalKey(Count) });
export type RunRecord = Types.Mutable<typeof RunRecord.Type>;

export const CommandLimits = Schema.Struct({
  memory: Schema.optionalKey(
    Schema.String.check(
      Schema.makeFilter(value => {
        const match = /^(\d+)([bkmg]?)$/i.exec(value);
        const bytes = match ? Number(match[1]) * 1024 ** 'bkmg'.indexOf((match[2] || 'b').toLowerCase()) : 0;
        return (bytes >= 6 * 1024 ** 2 && bytes <= 64 * 1024 ** 3) || 'expected a Docker size from 6m to 64g';
      })
    )
  ),
  cpus: Schema.optionalKey(Schema.Finite.check(Schema.isBetween({ minimum: 0.01, maximum: 64 }))),
});

export type Command = {
  limits?: typeof CommandLimits.Type;
  tools?: { url: string; host: string };
  cmd: string;
  args: string[];
  dir: string;
  graph?: string;
  home?: string;
  readonly?: boolean;
  env: Record<string, string>;
  secrets?: Record<string, Redacted.Redacted>;
  network: 'none' | 'proxy' | 'open';
  minutes: number;
};

const Used = Schema.optionalKey(Schema.Struct({ peak: Schema.Number, cpu: Schema.Number, oom: Flag }));

export type Exit = { code: number; output: string; used?: typeof Used.Type };

export type Checkout = {
  dir: string;
  base: string;
  head?: string;
  saved?: string;
  published?: string;
  ready?: boolean;
  env?: Extract<Trace, { env: unknown }>['env'];
  git: { GIT_DIR: string; GIT_WORK_TREE: string; GIT_INDEX_FILE?: string };
  news: string;
  written?: () => Promise<number | undefined>;
  image?: { id: string; packages: Record<string, string> };
};

export const formatCause = (cause: unknown): string => {
  try {
    if (cause instanceof Error) return cause.message;
    if (typeof cause === 'string') return cause;
    const util = globalThis.process?.getBuiltinModule?.('node:util');
    return util ? util.inspect(cause, { depth: 2 }) : Formatter.format(cause);
  } catch {
    return 'an unprintable value';
  }
};

export const SessionSpec = Schema.Struct({
  mcp: Schema.optionalKey(
    Schema.Struct({ url: Schema.String, host: Schema.String, secret: Schema.String, tools: Strings })
  ),
  harness: Schema.String,
  model: Text,
  system: Schema.String,
  prompt: Schema.String,
  dir: Schema.String,
  base: Text,
  tools: Strings,
  read: Schema.optionalKey(Strings),
  agent: Schema.String,
  check: Text,
  returns: Check.fields.returns,
  minutes: Schema.Number,
  resume: Schema.optionalKey(Kept),
  fork: Flag,
  limits: Schema.optionalKey(CommandLimits),
});
export type SessionSpec = Types.Mutable<typeof SessionSpec.Type>;

const End = Schema.Struct({
  type: Schema.Literal('end'),
  final: Schema.String,
  ended: Schema.Literals(['stop', 'cap', 'error']),
  exit: Schema.Number,
  provider: Text,
  used: Used,
});

export const SessionEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('start'),
    session: Schema.String,
    harness: Text,
    provider: Text,
    model: Schema.String,
    home: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal('text'), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal('thinking'), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal('tool'),
    id: Schema.String,
    name: Schema.String,
    input: Schema.Unknown,
    output: Text,
    ok: Schema.optionalKey(Schema.Boolean),
    exit: Schema.optionalKey(Schema.Number),
    denied: Flag,
    ms: Schema.optionalKey(Schema.Number),
  }),
  // UNEXPECTED: `input` counts every input token, cache reads and writes among them.
  Schema.Struct({
    type: Schema.Literal('usage'),
    input: Schema.Number,
    output: Schema.Number,
    cacheRead: Schema.optionalKey(Schema.Number),
    cacheWrite: Schema.optionalKey(Schema.Number),
    usd: Schema.optionalKey(Schema.Number),
    unpriced: Text,
    model: Text,
  }),
  End,
]);
export type SessionEvent = typeof SessionEvent.Type;

const StopReason = Schema.Literals(['timeout', 'stalled', 'budget', 'provider', 'login', 'human', 'sandbox']);

export class SessionStop extends Data.TaggedError('SessionStop')<{
  reason: typeof StopReason.Type;
  detail?: string;
}> {}

const Line = { at: Schema.String, step: Schema.String };

export const Trace = Schema.Union([
  Schema.Struct({
    ...Line,
    prompt: SessionSpec,
    key: Text,
    item: Text,
    aside: Schema.optionalKey(Schema.Struct({ issue: Schema.optionalKey(Count), comment: Text, review: Flag })),
  }),
  Schema.Struct({ ...Line, event: SessionEvent, key: Text }),
  Schema.Struct({
    ...Line,
    key: Text,
    session: Schema.Struct({
      id: Text,
      resumed: Schema.Boolean,
      dropped: Text,
      aside: Flag,
      ended: Schema.Union([End.fields.ended, StopReason]),
      exit: Schema.optionalKey(Schema.Number),
      usd: Schema.Number,
      unpriced: Text,
      used: Used,
    }),
  }),
  Schema.Struct({ ...Line, setup: Schema.Struct({ ms: Schema.Number, exit: Schema.Number, used: Used }) }),
  Schema.Struct({ ...Line, cache: Schema.Struct({ files: Schema.Number }) }),
  Schema.Struct({
    ...Line,
    env: Schema.Struct({ key: Schema.String, mode: Schema.Literals(['deps', 'tree']), match: Schema.Boolean }),
  }),
  Schema.Struct({ ...Line, applied: Applied }),
  Schema.Struct({
    ...Line,
    outcome: Outcome,
    run: Run.mapFields(Struct.pick(['step', 'status', 'tries', 'rounds', 'reason', 'waiting'])),
    failure: Schema.optionalKey(StopReason),
  }),
  Schema.Struct({
    ...Line,
    saved: Run.mapFields(Struct.map(Schema.optionalKey)),
    cleared: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.Literals(Struct.keys(Run.fields))))),
  }),
  Schema.Struct({ ...Line, spoken: Event, meta: RunFields.meta }),
  Schema.Struct({ ...Line, inputs: Schema.Struct({ since: Schema.String }) }),
  Schema.Struct({ ...Line, told: Schema.Struct({ text: Schema.String, by: Schema.String }) }),
]);
export type Trace = typeof Trace.Type;

export const Log = Schema.Struct({ hash: Schema.String, bytes: Schema.Number });
export type Log = typeof Log.Type;

export const CheckEntry = Schema.Struct({
  ...Line,
  check: CheckResult,
  version: Schema.String,
  usd: Schema.Number,
  unpriced: Text,
  item: Text,
  exit: Schema.optionalKey(Schema.Number),
  log: Schema.optionalKey(Log),
  later: Flag,
  used: Used,
});
export type CheckEntry = typeof CheckEntry.Type;

export class TrackerError extends Data.TaggedError('TrackerError')<{
  status?: number;
  message: string;
  moved?: true;
}> {}

export class StoreError extends Data.TaggedError('StoreError')<{ path: string; cause: unknown }> {
  override get message() {
    const cause = formatCause(this.cause);
    return cause.startsWith(this.path) ? cause : `${this.path}: ${cause}`;
  }
}

export type InstanceHost = {
  readonly data: string;
  readonly checks?: Readonly<Record<string, Check & { version: string }>>;
  readonly store: {
    getRecord: (id: string) => Effect.Effect<RunRecord | undefined, StoreError>;
    list: (filter?: Partial<Pick<Run, 'workflow' | 'issue' | 'status'>>) => Effect.Effect<Run[], StoreError>;
    listRecords: (
      filter?: Partial<Pick<Run, 'workflow' | 'issue' | 'status'>>
    ) => Effect.Effect<RunRecord[], StoreError>;
    read: (id: string, from?: number) => Stream.Stream<Trace, StoreError>;
    readChecks: (id: string) => Effect.Effect<CheckEntry[], StoreError>;
    readLog: (hash: string) => Effect.Effect<string | undefined, StoreError>;
  };
  readonly tracker: {
    issues: (
      filter?: Partial<Pick<Issue, 'state' | 'labels' | 'parent'>> & Partial<Pick<NonNullable<Issue['pull']>, 'branch'>>
    ) => Effect.Effect<Issue[], TrackerError>;
    issue: (number: number) => Effect.Effect<Issue & { events: Event[] }, TrackerError>;
    since: (cursor: string, columns?: boolean) => Stream.Stream<Event, TrackerError>;
  };
  readonly readRuns: () => {
    readonly data: string;
    readonly run: RunRecord;
    readonly labels: Readonly<Record<string, string>>;
    readonly latest: readonly CheckEntry[];
  }[];
};

export type InstanceHosts = Readonly<Record<string, InstanceHost | { why: string }>>;

export const formatReason = ({ reason, waiting }: Pick<Run, 'reason' | 'waiting'>) =>
  waiting?.on === 'run'
    ? `waiting on ${waiting.id}`
    : waiting?.on === 'limits'
      ? waiting.why
      : waiting
        ? `Stopped by an engine error${waiting.error ? ` (${waiting.error})` : ''}.`
        : reason;

export const isWaitingOnPeople = (run: Partial<Pick<Run, 'status' | 'waiting'>>) =>
  run.status === 'waiting' && (run.waiting === undefined || run.waiting.on === 'limits');
