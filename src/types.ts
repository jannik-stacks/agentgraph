import { Data, Effect, Formatter, type Redacted, Schema, type Stream, Struct, type Types } from 'effect';
import { Applied, Count, Event, type Issue } from './event.ts';
import { PluginMetadata } from './meta.ts';
import { Kind, Proposal } from './proposal.ts';
import { CheckMode, ResultType } from './result.ts';

const Tally = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** An agent file's frontmatter. */
export const Agent = Schema.Struct({
  harness: Schema.String.pipe(Schema.withDecodingDefaultType(Effect.succeed(''))),
  model: Schema.optionalKey(Schema.String),
  tools: Schema.mutable(Schema.Array(Schema.String)).pipe(Schema.withDecodingDefaultType(Effect.succeed([]))),
  returns: Schema.mutable(Schema.Array(Kind)).pipe(Schema.withDecodingDefaultType(Effect.succeed(['comment']))),
  reads: Schema.optionalKey(Schema.Literal('traces')),
  session: Schema.optionalKey(Schema.Literals(['fresh', 'same'])),
});
export type Agent = typeof Agent.Type;

/**
 * A check is items, a command and an agent that judges. Each gives a result `returns` describes, which passes when it
 * matches `pass`. `info` only records it, `warn` records a failure, `block` fails the try and `stop` the run.
 */
export const Check = Schema.Struct({
  mode: CheckMode,
  returns: Schema.optionalKey(ResultType),
  pass: Schema.optionalKey(ResultType),
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
  ])
);

/**
 * A check's result: whether it passed, the `value` its result held when the check has its own `returns`, and with
 * `each` the `share` of items that passed. `empty` means no evidence: `each` found nothing, or a result could not
 * be read, with the reason in `findings`.
 */
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

/** How one try of a step ended, or what a human said to a waiting run. */
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

/** How far a session has read its issues: the time of the last event it saw and the base its pull request was on. */
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

/** Where one workflow run on one issue stands. */
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

/** One command in the sandbox: `dir` is its working directory, `home` its `HOME` when given and, with `readonly`, writable alongside scratch. */
export type Command = {
  limits?: typeof CommandLimits.Type;
  tools?: { url: string; host: string };
  cmd: string;
  args: string[];
  dir: string;
  /** The graph directory, readable by the command as `$AGENTGRAPH_DIR`, never writable. */
  graph?: string;
  home?: string;
  readonly?: boolean;
  env: Record<string, string>;
  secrets?: Record<string, Redacted.Redacted>;
  /** `open` reaches any host. */
  network: 'none' | 'proxy' | 'open';
  minutes: number;
};

const Used = Schema.optionalKey(Schema.Struct({ peak: Schema.Number, cpu: Schema.Number, oom: Flag }));

export type Exit = { code: number; output: string; used?: typeof Used.Type };

/**
 * A checkout: the work tree `dir`, the commit `base` its change is measured from, and `git`, the repo and index host git
 * uses for it. On an existing branch `base` is where the branch forks from the ref, and `head` is the branch commit the
 * files start from.
 * `git` names only paths the host keeps out of the sandbox's reach. `news` is a file outside `dir` that only the host
 * writes; the sandbox reads it at the same path.
 */
export type Checkout = {
  dir: string;
  base: string;
  head?: string;
  saved?: string;
  published?: string;
  /** The checkout starts from a sandbox setup that already ran the graph's setup on these files. */
  ready?: boolean;
  /** The sandbox setup the checkout starts from, how it was built, and whether it was built from the checkout's own files. */
  env?: Extract<Trace, { env: unknown }>['env'];
  git: { GIT_DIR: string; GIT_WORK_TREE: string; GIT_INDEX_FILE?: string };
  news: string;
  /** How many files the checkout's commands wrote over the shared cache so far, when the sandbox can tell. */
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
  /** Directories outside `dir` the session may read. */
  read: Schema.optionalKey(Strings),
  agent: Schema.String,
  /** The check this session judges, when it judges one. */
  check: Text,
  returns: Check.fields.returns,
  minutes: Schema.Number,
  resume: Schema.optionalKey(Kept),
  /** Opens a copy of `resume` in a new home, leaving the resumed session as it was. */
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

/** What a session does, as the harness reports it. `end` comes once the harness exits; with `ended: 'error'` and no reply, `final` holds the harness's error. */
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
    /** How long the tool ran, when the harness says. */
    ms: Schema.optionalKey(Schema.Number),
  }),
  /** `input` counts every input token, cache reads and writes among them. */
  Schema.Struct({
    type: Schema.Literal('usage'),
    input: Schema.Number,
    output: Schema.Number,
    cacheRead: Schema.optionalKey(Schema.Number),
    cacheWrite: Schema.optionalKey(Schema.Number),
    usd: Schema.optionalKey(Schema.Number),
    /** The model no list price was found for, when the harness reported no cost either. */
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

/**
 * One line of a run's trace. A `prompt` line holds everything a session is opened with and precedes its events. A
 * `saved` line holds the fields of `run.json` that a put changed, and `cleared` the ones it removed. A session's prompt,
 * event and session lines share its `key`, so sessions running at once stay apart. Check results are not trace lines but
 * entries of the run's check record. A `spoken` line holds a CLI command or an event the run heard from its tracker, and
 * the `inputs` line says since when the run records what it hears. An `aside` names the comment an aside answered,
 * when the run noted it.
 */
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

/** A check's full output in the store: its sha256 and its length in bytes. */
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
    return `${this.path}: ${formatCause(this.cause)}`;
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
    : waiting
      ? `Stopped by an engine error${waiting.error ? ` (${waiting.error})` : ''}.`
      : reason;

export const isWaitingOnPeople = (run: Partial<Pick<Run, 'status' | 'waiting'>>) =>
  run.status === 'waiting' && run.waiting === undefined;
