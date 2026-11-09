import { Data, Effect, Formatter, type Redacted, Schema, type Stream, type Types } from 'effect';
import type { Applied, Event, Issue } from './event.ts';
import { PluginMetadata } from './meta.ts';
import { Kind, Proposal } from './proposal.ts';
import { CheckMode, type Result, ResultType } from './result.ts';

/** An agent file's frontmatter. */
export const Agent = Schema.Struct({
  harness: Schema.String.pipe(Schema.withDecodingDefaultType(Effect.succeed(''))),
  model: Schema.optionalKey(Schema.String),
  tools: Schema.mutable(Schema.Array(Schema.String)).pipe(Schema.withDecodingDefaultType(Effect.succeed([]))),
  returns: Schema.mutable(Schema.Array(Kind)).pipe(Schema.withDecodingDefaultType(Effect.succeed(['comment']))),
  reads: Schema.optionalKey(Schema.Literal('traces')),
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
  each: Schema.optionalKey(Schema.String),
  run: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  max: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type Check = typeof Check.Type;

/**
 * A check's result: whether it passed, the `value` its result held when the check has its own `returns`, and with
 * `each` the `share` of items that passed. `empty` means no evidence: `each` found nothing, or a result could not
 * be read, with the reason in `findings`.
 */
export type CheckResult = {
  check: string;
  pass: boolean;
  value?: Result;
  share?: number;
  empty?: true;
  na?: true;
  findings?: string;
  ms: number;
};

/** How one try of a step ended, or what a human said to a waiting run. */
export type Outcome =
  | { kind: 'pass'; answered?: true; text?: string }
  | { kind: 'failed'; checks: CheckResult[]; proposals: Applied[]; problems: string[] }
  | { kind: 'back'; why: string }
  | { kind: 'ask'; question: string }
  | { kind: 'answer'; text: string }
  | { kind: 'stop'; why: string; restarted?: true };

const Text = Schema.optionalKey(Schema.String);
const Flag = Schema.optionalKey(Schema.Literal(true));
const Strings = Schema.mutable(Schema.Array(Schema.String));

/** How far a session has read its issues: the time of the last event it saw and the base its pull request was on. */
export const Seen = Schema.Struct({ at: Schema.String, base: Text });
export type Seen = Types.Mutable<typeof Seen.Type>;

const RunFields = {
  meta: Schema.optionalKey(PluginMetadata),
  id: Schema.String,
  workflow: Schema.String,
  title: Text,
  body: Text,
  step: Schema.String,
  status: Schema.Literals(['running', 'waiting', 'done', 'stopped']),
  tries: Schema.Number,
  rounds: Schema.Record(Schema.String, Schema.Number),
  sessions: Schema.Record(
    Schema.String,
    Schema.Struct({ id: Schema.String, home: Schema.String, seen: Schema.optionalKey(Seen) })
  ),
  feedback: Text,
  reported: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  answers: Schema.optionalKey(
    Schema.mutable(Schema.Array(Schema.Struct({ asked: Schema.String, said: Schema.String })))
  ),
  reason: Text,
  restarted: Flag,
  retried: Flag,
  seen: Text,
  said: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.Struct({ issue: Schema.Number, under: Text })))),
  eyes: Schema.optionalKey(Schema.Struct({ issue: Schema.Number, undo: Proposal.members[1] })),
  base: Schema.optionalKey(
    Schema.Struct({ pull: Schema.Number, branch: Schema.String, sha: Schema.String, from: Text, tip: Text })
  ),
  onto: Schema.optionalKey(Schema.Struct({ sha: Schema.String, merge: Flag })),
  graph: Text,
  graphTree: Text,
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
export const Run = Schema.Struct({ ...RunFields, issue: Schema.Number });
export type Run = Types.Mutable<typeof Run.Type>;

export const RunRecord = Schema.Struct({ ...RunFields, issue: Schema.optionalKey(Schema.Number) });
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

export type Exit = { code: number; output: string; used?: { peak: number; cpu: number; oom?: true } };

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
  env?: { key: string; mode: 'deps' | 'tree'; match: boolean };
  git: { GIT_DIR: string; GIT_WORK_TREE: string; GIT_INDEX_FILE?: string };
  news: string;
  /** How many files the checkout's commands wrote over the shared cache so far, when the sandbox can tell. */
  written?: () => Promise<number | undefined>;
};

export const formatCause = (cause: unknown): string => {
  try {
    return cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : Formatter.format(cause);
  } catch {
    return 'an unprintable value';
  }
};

export type SessionSpec = {
  mcp?: NonNullable<Command['tools']> & { secret: string; tools: string[] };
  harness: Agent['harness'];
  model?: string;
  system: string;
  prompt: string;
  dir: string;
  base?: string;
  tools: string[];
  /** Directories outside `dir` the session may read. */
  read?: string[];
  agent: string;
  /** The check this session judges, when it judges one. */
  check?: string;
  returns?: NonNullable<Check['returns']>;
  minutes: number;
  resume?: Run['sessions'][string];
  /** Opens a copy of `resume` in a new home, leaving the resumed session as it was. */
  fork?: true;
} & Pick<Command, 'limits'>;

/** What a session does, as the harness reports it. `end` comes once the harness exits; with `ended: 'error'` and no reply, `final` holds the harness's error. */
export type SessionEvent =
  | { type: 'start'; session: string; harness: string; provider?: string; model: string; home: string }
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | {
      type: 'tool';
      id: string;
      name: string;
      input: unknown;
      output?: string;
      ok?: boolean;
      exit?: number;
      denied?: true;
      /** How long the tool ran, when the harness says. */
      ms?: number;
    }
  /** `input` counts every input token, cache reads and writes among them. */
  | {
      type: 'usage';
      input: number;
      output: number;
      cacheRead?: number;
      cacheWrite?: number;
      usd?: number;
      /** The model no list price was found for, when the harness reported no cost either. */
      unpriced?: string;
    }
  | (Pick<Exit, 'used'> & {
      type: 'end';
      final: string;
      ended: 'stop' | 'cap' | 'error';
      exit: number;
      provider?: Extract<SessionEvent, { type: 'start' }>['provider'];
    });

export class SessionStop extends Data.TaggedError('SessionStop')<{
  reason: 'timeout' | 'stalled' | 'budget' | 'provider' | 'login' | 'human' | 'sandbox';
  detail?: string;
}> {}

/** The comment an aside answered, when the run noted it. */
export type Aside = { issue?: number; comment?: string; review?: true };

/**
 * One line of a run's trace. A `prompt` line holds everything a session is opened with and precedes its events. A
 * `saved` line holds the fields of `run.json` that a put changed, and `cleared` the ones it removed. A session's prompt,
 * event and session lines share its `key`, so sessions running at once stay apart. Check results are not trace lines but
 * entries of the run's check record.
 */
export type Trace = { at: string; step: string } & (
  | { prompt: SessionSpec; key?: string; item?: string; aside?: Aside }
  | { event: SessionEvent; key?: string }
  | {
      key?: string;
      session: Pick<Exit, 'used'> & {
        id?: string;
        resumed: boolean;
        aside?: true;
        ended: Extract<SessionEvent, { type: 'end' }>['ended'] | SessionStop['reason'];
        exit?: number;
        usd: number;
      };
    }
  | { setup: Pick<Exit, 'used'> & { ms: number; exit: number } }
  | { cache: { files: number } }
  | { env: NonNullable<Checkout['env']> }
  | { applied: Applied }
  | {
      outcome: Outcome;
      run: Pick<Run, 'step' | 'status' | 'tries' | 'rounds' | 'reason'>;
      failure?: SessionStop['reason'];
    }
  | { saved: Partial<Run>; cleared?: (keyof Run)[] }
  | ({ spoken: Event } & Pick<Run, 'meta'>)
  | { told: { text: string; by: string } }
);

/** A check's full output in the store: its sha256 and its length in bytes. */
export type Log = { hash: string; bytes: number };

export type CheckEntry = Pick<Exit, 'used'> & {
  at: string;
  step: string;
  check: CheckResult;
  version: string;
  usd: number;
  item?: string;
  exit?: number;
  log?: Log;
  later?: true;
};

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
