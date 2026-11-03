import { Effect, FileSystem, Layer, Option, Path, Stdio, Terminal } from 'effect';
import { Argument, CliConfig, CliError, CliOutput, Command, Flag, GlobalFlag } from 'effect/cli';
import { ChildProcessSpawner } from 'effect/process';

const text = (flag: Flag.Flag<string>) => flag.pipe(Flag.optional, Flag.map(Option.getOrUndefined));
const shared = {
  data: text(Flag.String('data')),
  repo: text(Flag.String('repo')),
  base: text(Flag.String('base')),
  dir: text(Flag.String('dir')),
  tracker: text(Flag.String('tracker').pipe(Flag.withDescription('<name>|<dir>'))),
  logs: text(Flag.String('logs').pipe(Flag.withDescription('all|failed|off'))),
  'read-only': Flag.Boolean('read-only').pipe(Flag.withDefault(false)),
  provider: text(Flag.String('provider')),
  save: Flag.Boolean('save').pipe(Flag.withDefault(false)),
  harness: text(Flag.String('harness')),
  model: text(Flag.String('model')),
};
const own = {
  workflow: text(Flag.String('workflow')),
  step: text(Flag.String('step')),
  issue: text(Flag.String('issue')),
  line: text(Flag.String('line').pipe(Flag.withDescription('<path>:<line>'))),
  as: text(Flag.String('as').pipe(Flag.withDescription('<branch>'))),
  patch: text(Flag.String('patch').pipe(Flag.withDescription('<file>'))),
  from: text(Flag.String('from').pipe(Flag.withDescription('<commit>'))),
  meta: text(Flag.String('meta').pipe(Flag.withDescription('<json file>'))),
  once: Flag.Boolean('once').pipe(Flag.withDefault(false)),
  apply: Flag.Boolean('apply').pipe(Flag.withDefault(false)),
  runs: Flag.Boolean('runs').pipe(Flag.withDefault(false)),
  parked: Flag.Boolean('parked').pipe(Flag.withDefault(false)),
  label: Flag.String('label').pipe(
    Flag.atLeast(0),
    Flag.map(labels => (labels.length ? [...labels] : undefined))
  ),
  'run-label': Flag.String('run-label').pipe(
    Flag.withDescription('<key>=<value>'),
    Flag.atLeast(0),
    Flag.map(labels => (labels.length ? [...labels] : undefined))
  ),
};
const table: [verb: string, args: string | undefined, flags: (keyof typeof own)[], what: string][] = [
  ['start', 'text', ['workflow', 'label', 'run-label'], 'files an issue and drives it until it waits or ends'],
  ['label', 'run key=value|key-', [], 'sets or removes labels on a run and prints them'],
  ['loop', undefined, ['once'], 'drives every open issue, again every AGENTGRAPH_EVERY minutes'],
  ['show', 'n|graph', [], 'what needs you and every issue, one issue in full, or the graph'],
  ['say', 'n text', ['line', 'label'], 'an /agent comment on issue n, then drives it'],
  ['review', 'n approve|changes text', [], "a review of issue n's pull request; changes drives it"],
  ['merge', 'n', [], "merges issue n's pull request and closes the issue"],
  ['export', 'n', ['as', 'patch'], "writes issue n's branch into your repo again"],
  ['close', 'n', [], 'closes issue n'],
  ['check', 'check', ['runs', 'issue', 'workflow'], 'validates the graph, or runs checks again on ended runs'],
  ['resume', 'run', ['parked'], 'queues runs parked by runner errors for the next loop pass'],
  ['dispatch', 'n text', ['workflow', 'step'], 'starts any workflow on issue n, asked the text; --step picks the step'],
  ['studio', undefined, [], 'starts the studio for this repo and prints its URL'],
  ['prune-logs', undefined, ['apply'], 'counts the check logs no run names, or deletes them'],
  ['import', 'commit|patch issue-file', ['from', 'meta'], 'records a change as an ended run, for check --runs'],
];

type Values = {
  [K in keyof typeof shared | keyof typeof own]: (typeof shared & typeof own)[K] extends Flag.Flag<infer A>
    ? A | undefined
    : never;
};
const cli = Layer.mergeAll(
  CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version] }),
  CliOutput.layer({ ...CliOutput.defaultFormatter(), formatVersion: (_name, version) => version }),
  FileSystem.layerNoop({}),
  Path.layer,
  Stdio.layerTest({}),
  Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(process.stdout.columns ?? 80),
      rows: Effect.succeed(process.stdout.rows ?? 24),
      readInput: Effect.die('no input'),
      readLine: Effect.die('no input'),
      display: out => Effect.sync(() => void process.stdout.write(out)),
    })
  ),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die('no processes'))
  )
);

export const readArgs = async (argv: string[], version: string) => {
  let parsed: { verb: string; values: Values; rest: string[] } | undefined;
  const agi = Command.make('agi').pipe(
    Command.withSharedFlags(shared),
    Command.withDescription('drives issues through an agent graph')
  );
  const commands = table.map(([name, args, flags, what]) =>
    Command.make(
      name,
      {
        ...Object.fromEntries(flags.map(flag => [flag, own[flag]])),
        ...(args && { rest: Argument.String(args).pipe(Argument.variadic()) }),
      },
      input =>
        Effect.map(agi, top => {
          const { rest = [], ...values } = input as Values & { rest?: string[] };
          parsed = { verb: name, values: { ...top, ...values }, rest: [...rest] };
        })
    ).pipe(Command.withDescription(what))
  );
  const run = Command.runWith(agi.pipe(Command.withSubcommands(commands)), { version });
  return Effect.runPromise(run(argv.length ? argv : ['--help']).pipe(Effect.provide(cli))).then(
    () => parsed ?? 0,
    (e: unknown) => {
      if (!(e instanceof CliError.ShowHelp)) console.error(e instanceof Error ? e.message : e);
      return e instanceof CliError.ShowHelp && !e.errors.length ? 0 : 2;
    }
  );
};
