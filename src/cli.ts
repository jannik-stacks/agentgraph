import { Effect, FileSystem, Layer, Path, Stdio, Terminal } from 'effect';
import { Argument, CliConfig, CliError, CliOutput, Command, Flag, GlobalFlag } from 'effect/cli';
import { ChildProcessSpawner } from 'effect/process';

const text = (flag: Flag.Flag<string>) =>
  flag.pipe(
    Flag.atLeast(0),
    Flag.map(values => values.at(-1))
  );
const many = (flag: Flag.Flag<string>) =>
  flag.pipe(
    Flag.atLeast(0),
    Flag.map(values => (values.length ? [...values] : undefined))
  );
const presence = new Set<string>();
const flag = (name: string) => {
  presence.add(`--${name}`);
  return Flag.Boolean(name).pipe(Flag.withoutNegation, Flag.withDefault(false));
};
const shared = {
  data: text(Flag.String('data')),
  instance: many(Flag.String('instance')),
  repo: text(Flag.String('repo')),
  base: text(Flag.String('base')),
  dir: text(Flag.String('dir')),
  tracker: text(Flag.String('tracker').pipe(Flag.withDescription('<name>|<dir>'))),
  runner: text(Flag.String('runner').pipe(Flag.withDescription('<name>'))),
  logs: text(Flag.String('logs').pipe(Flag.withDescription('all|failed|off'))),
  'read-only': flag('read-only'),
  provider: text(Flag.String('provider')),
  save: flag('save'),
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
  once: flag('once'),
  detach: flag('detach'),
  force: flag('force'),
  parallel: text(Flag.String('parallel').pipe(Flag.withDescription('<n>'))),
  apply: flag('apply'),
  runs: flag('runs'),
  parked: flag('parked'),
  label: many(Flag.String('label')),
  'run-label': many(Flag.String('run-label').pipe(Flag.withDescription('<key>=<value>'))),
  plugins: text(Flag.String('plugins').pipe(Flag.withDescription('<dir>'))),
};
const table: [verb: string, args: string | undefined, flags: (keyof typeof own)[], what: string][] = [
  ['start', 'text', ['workflow', 'label', 'run-label'], 'files an issue and drives it until it waits or ends'],
  ['label', 'run key=value|key-', [], 'sets or removes labels on a run and prints them'],
  [
    'loop',
    undefined,
    ['once', 'parallel', 'detach'],
    'drives every open issue of one or more instances, again every AGENTGRAPH_EVERY minutes',
  ],
  ['stop', undefined, ['force'], 'stops the loops of the instances and waits until they let go; --force ends them now'],
  ['restart', undefined, ['force', 'parallel'], 'stops the loops of the instances, then starts one in the background'],
  ['show', 'n|graph', [], 'what needs you and every issue, one issue in full, or the graph'],
  [
    'say',
    'n text',
    ['line', 'label'],
    'an /agent comment on issue n, then drives it; ":restart:implement" posts /agent:restart:implement',
  ],
  ['review', 'n approve|changes text', [], "a review of issue n's pull request; changes drives it"],
  ['merge', 'n', [], "merges issue n's pull request and closes the issue"],
  ['export', 'n', ['as', 'patch'], "writes issue n's branch into your repo again"],
  ['close', 'n', [], 'closes issue n'],
  ['check', 'check', ['runs', 'issue', 'workflow'], 'validates the graph, or runs checks again on ended runs'],
  ['resume', 'run', ['parked'], 'queues runs parked by runner errors for the next loop pass'],
  ['dispatch', 'n text', ['workflow', 'step'], 'starts any workflow on issue n, asked the text; --step picks the step'],
  ['studio', undefined, ['plugins'], 'starts the studio for this repo and prints its URL'],
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
  CliOutput.layer({
    ...CliOutput.defaultFormatter(),
    formatVersion: (_name, version) => version,
  }),
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

const asPresence = (argv: string[]) => {
  const end = argv.includes('--') ? argv.indexOf('--') : argv.length;
  const valued = argv
    .slice(0, end)
    .map(arg => arg.replace(/=.*/s, ''))
    .find((name, i) => name !== argv[i] && presence.has(name));
  if (valued) return `${valued} takes no value`;
  return argv.map((arg, i) => (i < end && presence.has(arg) ? `${arg}=true` : arg));
};

export const readArgs = async (argv: string[], version: string) => {
  const args = asPresence(argv);
  if (typeof args === 'string') {
    console.error(args);
    return 2;
  }
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
          const { rest = [], ...values } = input as Values & {
            rest?: string[];
          };
          parsed = {
            verb: name,
            values: { ...top, ...values },
            rest: [...rest],
          };
        })
    ).pipe(Command.withDescription(what))
  );
  const run = Command.runWith(agi.pipe(Command.withSubcommands(commands)), {
    version,
  });
  return Effect.runPromise(run(args.length ? args : ['--help']).pipe(Effect.provide(cli))).then(
    () => parsed ?? 0,
    (e: unknown) => {
      if (!(e instanceof CliError.ShowHelp)) console.error(e instanceof Error ? e.message : e);
      return e instanceof CliError.ShowHelp && !e.errors.length ? 0 : 2;
    }
  );
};
