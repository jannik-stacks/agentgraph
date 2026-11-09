#!/usr/bin/env node
import { readInstallationReach } from '../src/github.ts';
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { Config, ConfigProvider, Effect, Redacted, Semaphore, Stream } from 'effect';
import { readArgs } from '../src/cli.ts';
import { startLoopDrives, type Instruction } from '../src/run/trigger.ts';
import type { Graph } from '../src/folder.ts';
import { findIssueDir, formatAgentComment, Tracker, waitForTrackerEdit, writeAgentComment } from '../src/tracker.ts';
import { readConfiguredGraph, readHarnessSettings, splitNames, type Provider } from '../src/harnesses.ts';
import {
  ensureInstanceGraph,
  ensureInstance,
  writePullToRepo,
  findInstances,
  readInstance,
  readPickedInstance,
  readRealPath,
  findPull,
  findRepo,
  mergePull,
  ensureBase,
  writeClosed,
  writeComment,
  writeReview,
  writeInstanceProvider,
  formatGraphName,
  whyGraphUncommitted,
  writeImportedRun,
  type Instance,
} from '../src/instance.ts';
import type { JsonValue } from '../src/meta.ts';
import { removeShellSettings, readInstanceEnv, start, writeTriggeringIssue } from '../src/main.ts';
import { createLoopLock, LockHeldError, readLoopHolder } from '../src/owner.ts';
import {
  findLoginProvider,
  findRunsWaitingOnPeople,
  formatInstanceFlags,
  formatIssueList,
  formatIssueTimeline,
  formatNextSteps,
  formatRunnerError,
  formatShellWord,
} from '../src/status.ts';
import { isOnIssue } from '../src/graph.ts';
import {
  makeTrackerSetup,
  pickTracker,
  readHostSettings,
  hostSettings,
  makeRunner,
  settings,
  whyRunnerRefuses,
} from '../src/services.ts';
import { fileStore, pruneLogs, Store, writeIdleRunsCompressed } from '../src/store.ts';
import { parseLabelPatch, parseLabels, writeStoredRunLabels } from '../src/labels.ts';
import type { Run, RunRecord } from '../src/workflow.ts';

const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string })
  .version;
const parsed = await readArgs(process.argv.slice(2), version);
if (typeof parsed === 'number') process.exit(parsed);
const { values, rest } = parsed;
let { verb } = parsed;
const overrides = values.base === undefined ? {} : { base: values.base };
const usage = `see agi ${verb} --help`;
class Failure extends Error {
  code: number;
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}
process.on('uncaughtException', e => {
  console.error(e instanceof Failure ? e.message : e);
  process.exit(e instanceof Failure ? e.code : 1);
});
const fail = (message: string, code = 2): never => {
  throw new Failure(message, code);
};
const formatLoopFlags = (names: string[]) =>
  `${names.map(name => ` --instance ${formatShellWord(name)}`).join('')} --data ${formatShellWord(root)}`;
type InstanceEnv = Awaited<ReturnType<typeof readInstanceEnv>>;
const isIssueNumber = (k: number) => Number.isInteger(k) && k > 0;
const n = Number(rest[0]);
const numbered = () => (isIssueNumber(n) ? n : fail(`${verb} takes an issue number\n${usage}`));
const said = () => rest.slice(1).join(' ').trim();
const startLabels = (() => {
  try {
    return parseLabels(parseLabelPatch(values['run-label'] ?? []));
  } catch (e) {
    return fail((e as Error).message);
  }
})();
const relabel = async (data: string) => {
  const [id = '', ...words] = rest;
  try {
    const labels = await Effect.runPromise(writeStoredRunLabels(data, id, parseLabelPatch(words)));
    for (const [key, value] of Object.entries(labels)) console.log(`${key}=${value}`);
  } catch (e) {
    fail((e as Error).message);
  }
};
const listRuns = (data: string, filter: Parameters<Store['Service']['list']>[0] = {}) =>
  Effect.runPromise(Effect.flatMap(Store, s => s.list(filter)).pipe(Effect.provide(fileStore(data))));
const printRuns = (runs: RunRecord[], tag = '') => {
  if (verb === 'resume' && !runs.length) console.log('0 runs parked by runner errors');
  for (const run of runs)
    console.log(`${tag}${run.id} ${run.step} ${run.status}${run.reason ? `: ${run.reason}` : ''}`);
};
const formatRunnerErrors = async (data: string, runs: Run[]) => {
  const lines: string[] = [];
  for (const run of runs.filter(r => r.status === 'waiting' && r.retried)) {
    const trace = await Effect.runPromise(
      Effect.flatMap(Store, s => Stream.runCollect(s.read(run.id))).pipe(Effect.provide(fileStore(data)))
    );
    lines.push(...formatRunnerError([...trace], join(data, run.id, 'trace.jsonl')));
  }
  return lines;
};
const makeHarnessChoice = (provider: string | undefined) => ({
  provider,
  harness: values.harness,
});
const formatUnserved = (provider: Provider, harness: string) =>
  `${provider.name} does not serve ${harness}. It serves ${provider.harnesses.join(' and ')}.`;
const checkGraph = async (graph: string, i: Instance | undefined) => {
  const dir = scope.env.AGENTGRAPH_DIR;
  const host = { dir: graph, fromRepo: !!dir && !isAbsolute(dir) };
  const picked = selection && existsSync(graph) && (await pickTracker(selection, host));
  const problems = await Effect.runPromise(
    Effect.all([readHarnessSettings, readConfiguredGraph(graph, i, overrides), Config.all(hostSettings)]).pipe(
      Effect.flatMap(([{ providers = [], provider: named }, loaded, s]) => {
        const provider = providers.find(p => p.name === named);
        return Effect.map(whyRunnerRefuses(s, host, loaded), refused => [
          ...(provider ? findUnserved(provider, loaded) : []),
          ...(refused ? [{ path: 'runner', message: refused }] : []),
        ]);
      }),
      Effect.catchTag('GraphError', e => Effect.succeed(e.problems)),
      Effect.provideService(ConfigProvider.ConfigProvider, scope.config)
    )
  );
  if (picked && 'problem' in picked) problems.push({ path: 'tracker', message: picked.problem });
  for (const p of problems) console.error(`${p.path}: ${p.message}`);
  console.log(problems.length ? `${problems.length} problem(s)` : 'ok');
  process.exit(problems.length ? 1 : 0);
};

const pickProvider = async (
  i: Instance,
  after: string,
  scope: InstanceEnv
): Promise<{ provider: Provider; ready?: boolean }> => {
  const { providers = [], provider: named } = await Effect.runPromise(
    readHarnessSettings.pipe(Effect.provideService(ConfigProvider.ConfigProvider, scope.config))
  ).catch((e: Error) => fail(e.message, 1));
  if (named)
    return {
      provider:
        providers.find(p => p.name === named) ??
        fail(`no provider ${named}; the config has ${providers.map(p => p.name).join(', ')}`),
    };
  const found: { provider: Provider; ready: boolean }[] = [];
  const at = await readProviderHost(scope);
  for (const provider of providers) {
    const ready = await provider.ready(at);
    if (ready || (await provider.detect?.(at))) found.push({ provider, ready });
  }
  if (found.length === 0)
    fail(['No model to use.', ...providers.flatMap(p => (p.setup ? [`  ${p.setup}`] : [])), after].join('\n'), 1);
  if (found.length === 1) {
    writeInstanceProvider(i, found[0]!.provider.name);
    return found[0]!;
  }
  const names = found.map(f => f.provider.name);
  if (!process.stdin.isTTY) fail(`${names.join(' and ')} are ready; pass --provider ${names.join(' or --provider ')}`);
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await lines.question(`${names.join(' and ')} are ready. Use which? [${names.join('/')}] `)).trim();
  lines.close();
  const picked =
    found.find(f => f.provider.name === answer) ?? fail(`${answer || 'nothing'} is not one of ${names.join(', ')}`);
  writeInstanceProvider(i, picked.provider.name);
  return picked;
};

const readProviderHost = async (scope: InstanceEnv) => ({
  ...(await Effect.runPromise(
    Config.all(hostSettings).pipe(Effect.provideService(ConfigProvider.ConfigProvider, scope.config))
  )),
  env: scope.env,
});

const applySettings = async (provider: Provider, i: Instance, scope: InstanceEnv) =>
  readInstanceEnv(
    i,
    makeHarnessChoice(provider.name),
    { ...defaults, ...(await provider.settings?.(await readProviderHost(scope))) },
    commandEnv
  );

const findUnserved = (provider: Provider, graph: Graph) =>
  Object.values(graph.agents)
    .filter(a => !provider.harnesses.includes(a.harness))
    .map(a => ({
      path: a.path,
      message: formatUnserved(provider, a.harness),
    }));

const connect = async (i: Instance, graph: string, after: string, local: boolean, first: InstanceEnv, tag = '') => {
  const { provider, ready } = await pickProvider(i, after, first);
  let scope = await readInstanceEnv(i, makeHarnessChoice(provider.name), defaults, commandEnv);
  scope.env.AGENTGRAPH_DIR = graph;
  if (values.save && values.provider) writeInstanceProvider(i, provider.name);
  const harness = values.harness ?? provider.harnesses[0]!;
  if (!provider.harnesses.includes(harness)) fail(`${formatUnserved(provider, harness)}\n${after}`);
  console.log(
    `${tag}agentgraph ${version}: ${harness} on ${provider.name}, ${await formatGraphName(i, graph)}, ${local ? 'local' : scope.env.AGENTGRAPH_TRACKER} tracker`
  );
  console.log(`${tag}repo     ${i.checkout}, base ${i.base}`);
  const at = await readProviderHost(scope);
  if (!(ready ?? (await provider.ready(at))))
    await (
      provider.login ??
      (() => Promise.reject(new Error([`${provider.name} is not ready`, provider.setup].filter(Boolean).join('\n'))))
    )(at).catch((e: Error) => fail(`${e.message}\n${after}`, 1));
  scope = await applySettings(provider, i, scope).catch((e: Error) => fail(`${e.message}\n${after}`, 1));
  scope.env.AGENTGRAPH_DIR = graph;
  const runner = await Effect.runPromise(
    Effect.gen(function* () {
      const s = yield* settings;
      const { image = s.image } = yield* readConfiguredGraph(graph, i, overrides);
      return yield* makeRunner({ ...s, image });
    }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, scope.config))
  ).catch((e: Error) => fail(`${e.message}\n${after}`, 1));
  console.log(`${tag}runner   ${scope.env.AGENTGRAPH_RUNNER ?? 'local'}`);
  const aliases = new Map(
    splitNames(scope.env.AGENTGRAPH_MODELS ?? '').map(pair => pair.split('=', 2) as [string, string])
  );
  return { provider, scope, runner, ...(values.model && { model: aliases.get(values.model) ?? values.model }) };
};

const loadServedGraph = async (
  { provider, model, runner }: Awaited<ReturnType<typeof connect>>,
  graph: string,
  instance: Instance,
  scope: InstanceEnv
) => {
  const loaded = await Effect.runPromise(
    readConfiguredGraph(graph, instance, overrides).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, scope.config)
    )
  );
  if (model)
    scope.env.AGENTGRAPH_MODELS = ['*', ...Object.values(loaded.agents).flatMap(a => a.model ?? [])]
      .map(alias => `${alias}=${model}`)
      .join(',');
  const unserved = findUnserved(provider, loaded);
  if (unserved.length) throw new Error(unserved.map(p => `${p.path}: ${p.message}`).join('\n'));
  const refused = runner.whyRefused?.(loaded);
  if (refused) throw new Error(`runner: ${refused}`);
  return loaded;
};

const prepare = async (i: Instance, graph: string, after: string) => {
  const connection = await connect(i, graph, after, !!trackerSetup.origin.local, scope);
  scope = connection.scope;
  const loaded = await loadServedGraph(connection, graph, i, scope).catch((e: Error) =>
    fail(`${e.message}\n${after}`, 1)
  );
  return { loaded, provider: connection.provider.name };
};

const stopping = new AbortController();
const trapInterrupt = (release?: () => Promise<void>) => {
  const stop = async (signal: NodeJS.Signals) => {
    if (signal === 'SIGTERM' || stopping.signal.aborted) {
      await release?.();
      process.exit(signal === 'SIGTERM' ? 143 : 130);
    }
    console.error('stopping; runs resume where they were on the next drive (Ctrl-C again quits now)');
    stopping.abort();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
};

let trackerSetup: Awaited<ReturnType<typeof makeTrackerSetup>>;

const instruction =
  (verb === 'check' && values.runs) || verb === 'resume' || verb === 'dispatch' ? instructed() : undefined;
const host = await readHostSettings({ data: values.data }).catch((e: Error) => fail(e.message));
const root = host.data;
const defaults = {
  ...(host.config && { AGENTGRAPH_CONFIG: host.config }),
};
const commandEnv = {
  ...(values.logs !== undefined && { AGENTGRAPH_CHECK_LOGS: values.logs }),
  ...(values.tracker !== undefined && { AGENTGRAPH_TRACKER: values.tracker }),
  ...(values.runner !== undefined && { AGENTGRAPH_RUNNER: values.runner }),
};
const named = values.instance ?? [];
if (verb === 'stop' || verb === 'restart') {
  const repo = named.length ? undefined : await findRepo(resolve(values.repo ?? '.'));
  const all = findInstances(root);
  const picked = named.length
    ? await Promise.all(named.map(name => readPickedInstance(root, name, false))).catch((e: Error) => fail(e.message))
    : repo
      ? all.filter(i => i.checkout === readRealPath(repo))
      : all.filter(i => verb === 'stop' || i.loop);
  await stopLoops(
    picked.filter(i => i !== undefined),
    all
  );
  if (verb === 'stop') process.exit(0);
  verb = 'loop';
  values.detach = true;
}
if (named.length > 1 && verb !== 'loop') fail(`${verb} takes one --instance\n${usage}`);
if (verb === 'loop' && (named.length > 1 || (!named.length && !values.repo && !(await findRepo(resolve('.')))))) {
  for (const flag of ['repo', 'dir', 'base', 'tracker', 'runner', 'read-only'] as const)
    if (values[flag]) fail(`--${flag} applies to one instance; set it in each instance.yaml`);
  const served = named.length
    ? await Promise.all(named.map(name => readPickedInstance(root, name, false))).catch((e: Error) => fail(e.message))
    : findInstances(root).filter(i => i.loop);
  await loop(served.filter(i => i !== undefined));
  process.exit(0);
}
const saved = await readPickedInstance(root, named[0], values.repo !== undefined).catch((e: Error) => fail(e.message));
const checkout = saved && !values.repo ? saved.checkout : await findRepo(resolve(values.repo ?? '.'));
if (values.repo && !checkout) fail('--repo must name a readable git repo');
const isGraphCheck = verb === 'check' && values.dir !== undefined && !values.runs;
const i = isGraphCheck
  ? (saved ?? (checkout ? readInstance(root, basename(checkout)) : undefined))
  : checkout
    ? await ensureInstance(root, named[0], checkout, undefined, values['read-only']).catch((e: Error) =>
        fail(e.message)
      )
    : undefined;
let scope = await readInstanceEnv(i, makeHarnessChoice(values.provider), defaults, commandEnv);
const graphDir = values.dir ?? scope.env.AGENTGRAPH_DIR;
const selected = i ? formatInstanceFlags(i.checkout, root, basename(i.dir)) : '';
const selection = scope.env.AGENTGRAPH_TRACKER!;
if (isGraphCheck) await checkGraph(resolve(values.dir!), i);
if (!i) {
  if (verb === 'show') await showInstances(root);
  else fail(`${verb} runs inside a git repo, or pass --repo <dir>\n${usage}`);
} else {
  if (verb === 'prune-logs') {
    await prune(i.data);
    process.exit(0);
  }
  if (verb === 'label') {
    await relabel(i.data);
    process.exit(0);
  }
  if (
    verb === 'show' &&
    rest[0] !== 'graph' &&
    !['folder', 'github'].includes(selection) &&
    !existsSync(join(resolve(selection), 'origin.git'))
  ) {
    const runs = await listRuns(i.data, rest[0] ? { issue: numbered() } : {});
    printRuns(runs);
    for (const line of findRunsWaitingOnPeople(runs).flatMap(run => formatNextSteps(run, undefined, selected)))
      console.log(line);
    process.exit(0);
  }
  const graph =
    ((verb === 'show' && rest[0] !== 'graph') || ['export', 'close', 'import'].includes(verb)) &&
    ['folder', 'github'].includes(selection)
      ? ''
      : await ensureInstanceGraph(i, graphDir).catch((e: Error) => fail(e.message, 1));
  scope.env.AGENTGRAPH_DIR = graph;
  if (verb === 'show' && rest[0] === 'graph') {
    console.log(`graph ${graph}`);
    for (const file of readdirSync(graph, { recursive: true, encoding: 'utf8' }).toSorted()) console.log(`  ${file}`);
    process.exit(0);
  }
  const opened = await openTracker(i, scope);
  await runOnInstance(values.base === undefined ? opened.i : { ...opened.i, base: values.base }, opened, graph);
}

async function openTracker(instance: Instance, scope: InstanceEnv) {
  const current = await Effect.runPromise(
    settings.pipe(Effect.provideService(ConfigProvider.ConfigProvider, scope.config))
  );
  const setup = await makeTrackerSetup(current).catch((e: Error) => fail(e.message, 1));
  if (setup.origin.local && !existsSync(setup.origin.origin))
    fail(
      `the tracker folder ${instance.tracker} has no origin.git; restore it, or move ${instance.dir} aside to start anew`
    );
  const i = setup.origin.local ? { ...instance, tracker: dirname(setup.origin.origin) } : instance;
  return { i, setup, current };
}

function instructed(): Instruction {
  if (verb === 'resume') {
    if (values.parked && rest.length === 0) return { kind: 'resume', parked: true };
    if (!values.parked && rest.length === 1) return { kind: 'resume', id: rest[0]! };
    return fail('usage: agi resume <run id>|--parked');
  }
  if (verb === 'dispatch') {
    if (!values.workflow) fail('dispatch takes --workflow <name>');
    return {
      kind: 'dispatch',
      issue: numbered(),
      workflow: values.workflow!,
      ...(values.step && { step: values.step }),
      ...(said() && { text: said() }),
    };
  }
  if (!values.runs || rest.length === 0) fail('usage: agi check <check>... --runs [--workflow <name>] [--issue <n>]');
  const issue = Number(values.issue);
  if (values.issue !== undefined && !isIssueNumber(issue)) fail('--issue takes an issue number');
  return {
    kind: 'check',
    checks: rest,
    ...(values.workflow !== undefined && { workflow: values.workflow }),
    ...(values.issue !== undefined && { issue }),
  };
}

async function prune(data: string) {
  const { files, bytes } = await pruneLogs(data, values.apply);
  console.log(`${values.apply ? 'deleted' : 'would delete'} ${files} unreferenced log(s), ${bytes} bytes`);
}

async function runOnInstance(
  i: Instance,
  { setup, current }: Pick<Awaited<ReturnType<typeof openTracker>>, 'setup' | 'current'>,
  graph: string
) {
  trackerSetup = setup;
  const getTracker = () => Effect.runPromise(Effect.provide(Tracker, setup.layer(current.trust, i.owner)));
  const synced = async () => {
    const why = setup.origin.local && (await ensureBase(i));
    if (why) fail(why, 1);
    const uncommitted = await whyGraphUncommitted(i, graph);
    if (uncommitted) console.error(uncommitted);
    return graph;
  };
  switch (verb) {
    case 'studio':
      await synced();
      return openStudio(i);
    case 'start': {
      if (!setup.origin.local) fail("open the issue on the tracker; the App's own issues do not start runs");
      const text = rest.join(' ').trim();
      if (!text) fail(`start takes the issue text\n${usage}`);
      const graph = await synced();
      const { loaded, provider } = await prepare(i, graph, 'Nothing was filed.');
      if (values['run-label'] && readLoopHolder(i.checkout))
        fail(
          `a loop drives this repo, so the run is not started here: start without --run-label, then agi label <run id>${selected}`
        );
      const issue = await writeTriggeringIssue(
        loaded,
        setup.layer(loaded.trust, i.owner),
        text,
        i.owner,
        values.workflow,
        values.label
      ).catch((e: Error) => fail(e.message));
      console.log(`#${issue} ${text.split('\n')[0]}`);
      return drive(i, issue, graph, provider);
    }
    case 'say': {
      if (!setup.origin.local) fail("comment on the tracker; the App's own comments do not reach runs");
      if (!said()) fail(`say takes text\n${usage}`);
      const issue = await findPullIssue(i, numbered());
      const graph = await synced();
      const { provider } = await prepare(i, graph, 'Nothing was posted.');
      if (values.line) await writeComment(i.tracker, i.owner, n, formatAgentComment(said()), values.line);
      else
        await Effect.runPromise(Effect.provideService(writeAgentComment(n, said()), Tracker, await getTracker())).catch(
          (e: Error) => fail(e.message)
        );
      if (values.label)
        await Effect.runPromise((await getTracker()).apply(issue, { kind: 'label', add: values.label, remove: [] }));
      return drive(i, issue, graph, provider);
    }
    case 'review': {
      if (!setup.origin.local) fail('review this pull request on the tracker');
      const verdict = ({ approve: 'approved', changes: 'changes_requested' } as const)[
        rest[1] as 'approve' | 'changes'
      ];
      if (!verdict) fail('review takes approve or changes');
      const text = rest.slice(2).join(' ').trim();
      const issue = await findPullIssue(i, numbered());
      const graph = await synced();
      const prepared = verdict === 'changes_requested' && (await prepare(i, graph, 'Nothing was posted.'));
      await writeReview(i.tracker, i.owner, n, verdict, text).catch((e: Error) => fail(e.message));
      if (prepared) return drive(i, issue, graph, prepared.provider);
      console.log(`approved #${n}`);
      return;
    }
    case 'merge': {
      if (!setup.origin.local) fail('merge this pull request on the tracker');
      await synced();
      const pull = await mergePull(i, numbered()).catch((e: Error) => fail(e.message, 1));
      console.log(`${pull.base} at ${pull.head.slice(0, 7)} in agentgraph`);
      return report(i, n, true);
    }
    case 'export': {
      if (!setup.origin.local) fail('export applies to a local tracker');
      numbered();
      const result = await writePullToRepo(i, n, {
        ...(values.as && { as: values.as }),
        ...(values.patch && { patch: values.patch }),
      }).catch((e: Error) => fail(e.message, 1));
      if (!result) return fail(`#${n} has no pull request`, 1);
      if ('why' in result)
        return fail(values.patch ? result.why : `${result.why}; try --as <branch> or --patch <file>`, 1);
      if (!values.patch) return report(i, n, false, result);
      console.log(`${result.stat}\nPatch: ${result.ref}    git am ${formatShellWord(result.ref)}`);
      return;
    }
    case 'close': {
      if (!setup.origin.local) fail('close this issue on the tracker');
      const pull = await findPull(i.tracker, numbered());
      const open = new Set(
        (await Effect.runPromise((await getTracker()).issues({ state: 'open' }))).map(t => t.number)
      );
      const closed = [...new Set([n, await findPullIssue(i, n), pull?.number ?? n])].filter(k => open.has(k));
      for (const k of closed) await writeClosed(i.tracker, i.owner, k);
      console.log(closed.length ? `closed #${closed.join(' and #')}` : `nothing open on #${n}`);
      return;
    }
    case 'show':
      return rest[0] ? showIssue(await getTracker(), numbered(), i) : showAll(i, await getTracker());
    case 'check':
    case 'resume':
    case 'dispatch': {
      if (verb === 'check' && !values.runs) return checkGraph(await synced(), i);
      const graph = await synced();
      const { provider } = await prepare(i, graph, 'Nothing was driven.');
      trapInterrupt();
      return printRuns(
        await start(
          {
            graph,
            issue: 'all',
            data: i.data,
            instance: i,
            ...overrides,
            setup: { ...scope, tracker: trackerSetup },
            instruction: instruction!,
            choice: makeHarnessChoice(provider),
          },
          undefined,
          {},
          stopping.signal
        )
      );
    }
    case 'loop':
      return loop([i]);
    case 'import': {
      if (rest.length < 1 || rest.length > 2)
        fail(`import takes a commit or patch file, then an optional issue file\n${usage}`);
      const input =
        values.meta === undefined ? undefined : (JSON.parse(readFileSync(values.meta, 'utf8')) as JsonValue);
      const id = await writeImportedRun(i, rest[0]!, {
        version,
        ...(values.from && { from: values.from }),
        ...(rest[1] && { issue: rest[1] }),
        ...(input !== undefined && { input }),
      }).catch((e: Error) => fail(e.message, 1));
      console.log(id);
      return;
    }
    default:
      fail(usage);
  }
}

function watchRuns(i: Instance, issue: number) {
  const shown = new Map<string, string>();
  const look = async () => {
    for (const run of await listRuns(i.data, { issue }).catch((e: Error) => {
      console.error(`Could not read runs: ${e.message}`);
      return [];
    })) {
      const now = `${run.step}: ${run.status === 'running' ? 'working' : run.status}`;
      if (shown.get(run.id) !== now) console.log(`#${issue} ${now}`);
      shown.set(run.id, now);
    }
  };
  const timer = setInterval(() => void look(), 1000);
  return async () => {
    clearInterval(timer);
    await look();
  };
}

async function findPullIssue(i: Instance, n: number) {
  const branch = (await findPull(i.tracker, n))?.pull.branch ?? '';
  return Number(/^agentgraph\/(\d+)$/.exec(branch)?.[1] ?? n);
}

async function drive(i: Instance, issue: number, graph: string, provider: string) {
  trapInterrupt();
  if (readLoopHolder(i.checkout)) {
    console.log(`a loop drives this repo and takes #${issue} on its next pass; agi show ${issue}${selected}`);
    return;
  }
  const stop = watchRuns(i, issue);
  const runs = await start(
    {
      graph,
      issue,
      data: i.data,
      marked: true,
      instance: i,
      ...overrides,
      setup: { ...scope, tracker: trackerSetup },
      choice: makeHarnessChoice(provider),
      labels: startLabels,
    },
    undefined,
    {},
    stopping.signal
  ).catch((e: unknown) => {
    if (!stopping.signal.aborted) throw e;
    return undefined;
  });
  await stop();
  if (!runs) {
    console.log(`stopped; agi say ${issue} "go on"${selected} resumes it`);
    process.exit(130);
  }
  if (runs.length === 0) console.log(`nothing to do on #${issue}`);
  return trackerSetup.origin.local ? report(i, issue) : printRuns(runs);
}

function openStudio(i: Instance) {
  const dir = join(import.meta.dirname, '..', 'studio');
  if (!existsSync(join(dir, 'dev.ts')))
    fail('the studio runs from a clone of agentgraph, not the npm package; see The studio in docs/local.md', 1);
  if (!existsSync(join(dir, 'node_modules'))) {
    console.log(`studio   installing its dependencies once: npm ci --prefix ${dir}`);
    if (spawnSync('npm', ['ci', '--prefix', dir, '--no-audit', '--no-fund'], { stdio: 'inherit' }).status !== 0)
      fail('the studio install failed', 1);
  }
  const flags = [
    '--instance',
    basename(i.dir),
    '--data',
    root,
    ...(values.dir ? ['--dir', resolve(values.dir)] : []),
    ...(values.plugins ? ['--plugins', resolve(values.plugins)] : []),
  ];
  const { status } = spawnSync(process.execPath, [join(dir, 'watch.ts'), '--repo', i.checkout, ...flags], {
    cwd: dir,
    stdio: 'inherit',
    env: { ...process.env, AGI_STUDIO_HARNESS_CHOICE: JSON.stringify(makeHarnessChoice(values.provider)) },
  });
  if (status) process.exit(status);
}

async function report(
  i: Instance,
  issue: number,
  merged = false,
  written?: Awaited<ReturnType<typeof writePullToRepo>>
) {
  const result = written ?? (await writePullToRepo(i, issue, { auto: true }).catch((e: Error) => ({ why: e.message })));
  if (result && 'why' in result)
    console.log(
      `not written to your repo: ${result.why}\n  agi export ${issue} ${i.readonly ? '--patch <file>' : '--as <branch>'}${selected}`
    );
  else if (result) {
    const { ref, base, stat } = result;
    if (stat) console.log(`\n${stat}`);
    console.log(`In your repo: ${ref}    git diff ${formatShellWord(`${base}...${ref}`)}`);
    console.log(
      `Worktree:     git worktree add ${formatShellWord(`../${basename(i.checkout)}-${issue}`)} ${formatShellWord(ref)}`
    );
  }
  const runs = await listRuns(i.data, { issue });
  const waiting = findRunsWaitingOnPeople(runs).flatMap(run =>
    formatNextSteps(run, scope.env.AGENTGRAPH_TRACKER === 'github' ? scope.env.AGENTGRAPH_REPO : undefined, selected)
  );
  for (const line of waiting.filter(l => !l.startsWith('  '))) console.log(line);
  const last = runs.toSorted((a, b) => a.started.localeCompare(b.started)).at(-1);
  if (last?.status === 'stopped') console.log(`${last.id} stopped at ${last.step}: ${last.reason}`);
  if (last?.status === 'stopped') {
    const trace = await Effect.runPromise(
      Effect.flatMap(Store, s => Stream.runCollect(s.read(last.id))).pipe(Effect.provide(fileStore(i.data)))
    );
    const name = findLoginProvider([...trace], last.step);
    if (name) {
      const providers = await Effect.runPromise(
        readHarnessSettings.pipe(
          Effect.map(settings => settings.providers ?? []),
          Effect.provideService(ConfigProvider.ConfigProvider, scope.config)
        )
      ).catch((e: Error) => {
        console.error(`Could not read login providers: ${e.message}`);
        return [];
      });
      const why = providers.find(p => p.name === name)?.whyLogin?.();
      if (why) console.log(why);
    }
  }
  for (const line of await formatRunnerErrors(i.data, runs)) console.log(line);
  const merge = result && !('why' in result) ? [`  git merge ${formatShellWord(result.ref)}`] : [];
  const steps = merged
    ? merge
    : [...waiting.filter(l => l.startsWith('  ')), `  agi show ${issue}${selected}`, `  agi studio${selected}`];
  if (steps.length) console.log(`Next:\n${steps.join('\n')}`);
}

async function loop(instances: Instance[]) {
  if (!instances.length) fail(`no instance under ${root} has loop: true; set it in instance.yaml or pass --instance`);
  if (values.detach) return detach(instances);
  const parallel = values.parallel === undefined ? undefined : Number(values.parallel);
  if (parallel !== undefined && !(Number.isInteger(parallel) && parallel > 0))
    fail(`--parallel takes a whole number above 0\n${usage}`);
  if (parallel !== undefined && values.once) fail(`--parallel caps a continuous loop; drop --once or --parallel`);
  const shared = parallel === undefined ? undefined : Semaphore.makeUnsafe(parallel);
  const served: Promise<void>[] = [];
  trapInterrupt(() => (stopping.abort(), Promise.allSettled(served).then(() => {})));
  const several = instances.length > 1;
  removeShellSettings(instances.length);
  let failed = 0;
  await Promise.all(
    instances.map(i =>
      serve(i, several ? `${basename(i.dir)}: ` : '', shared, served).catch((e: unknown) => {
        if (!several) throw e;
        failed++;
        console.error(`${basename(i.dir)}: stopped: ${e instanceof Error ? e.message : String(e)}`);
      })
    )
  );
  if (failed) process.exit(1);
}

async function stopLoops(picked: Instance[], all: Instance[]) {
  const checkouts = new Set(picked.map(i => i.checkout));
  const held = new Map<number, string[]>();
  for (const i of picked) {
    const holder = readLoopHolder(i.checkout);
    if (!holder) console.log(`no loop on ${basename(i.dir)}`);
    else if (holder.host !== hostname())
      fail(`pid ${holder.pid} on ${holder.host} loops on ${basename(i.dir)}; stop it there`, 1);
    else held.set(holder.pid, [...(held.get(holder.pid) ?? []), basename(i.dir)]);
  }
  for (const [pid, names] of held) {
    const also = all.filter(i => !checkouts.has(i.checkout) && readLoopHolder(i.checkout)?.pid === pid);
    if (also.length)
      fail(
        `pid ${pid} also loops on ${also.map(i => basename(i.dir)).join(', ')}; name every instance it serves: agi ${verb}${formatLoopFlags([...names, ...also.map(i => basename(i.dir))])}`
      );
  }
  for (const [pid, names] of held) {
    process.kill(pid, values.force ? 'SIGTERM' : 'SIGINT');
    console.log(`stopping pid ${pid} (${names.join(', ')})${values.force ? '' : '; agi stop --force ends it now'}`);
  }
  while (picked.some(i => held.has(readLoopHolder(i.checkout)?.pid ?? 0))) await sleep(200);
}

async function detach(instances: Instance[]) {
  const names = instances.map(i => basename(i.dir));
  const log = join(root, 'logs', `loop-${names.join('+')}-${new Date().toISOString().slice(0, 10)}.log`);
  const args = process.argv
    .slice(2)
    .map(arg => (arg === 'restart' ? 'loop' : arg))
    .filter(arg => !/^--(detach|force)(=|$)/.test(arg));
  mkdirSync(dirname(log), { recursive: true });
  appendFileSync(log, `== ${new Date().toISOString()} agi ${args.join(' ')}\n`);
  const from = statSync(log).size;
  const out = openSync(log, 'a');
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, ...args], {
    detached: true,
    stdio: ['ignore', out, out],
  });
  closeSync(out);
  child.unref();
  let code: number | undefined;
  child.once('exit', exit => (code = exit ?? 1));
  while (code === undefined && !instances.every(i => readLoopHolder(i.checkout)?.pid === child.pid)) await sleep(200);
  if (code !== undefined) {
    process.stderr.write(readFileSync(log).subarray(from));
    process.exit(code);
  }
  console.log(`loop pid ${child.pid} on ${names.join(', ')}; log ${log}`);
  process.exit(0);
}

async function serve(
  instance: Instance,
  tag: string,
  shared: Semaphore.Semaphore | undefined,
  served: Promise<void>[]
) {
  const lock = await createLoopLock(
    instance.checkout,
    pid => console.error(`${tag}waiting for the stopping loop (pid ${pid}) to exit`),
    stopping.signal
  ).catch((e: unknown) => {
    const holder = e instanceof LockHeldError && readLoopHolder(instance.checkout);
    if (stopping.signal.aborted) return undefined;
    if (!holder) throw e;
    const flags = formatLoopFlags([basename(instance.dir)]);
    const where = holder.host === hostname() ? '' : ` on ${holder.host}`;
    return fail(
      `pid ${holder.pid}${where} already loops on ${instance.checkout}; agi stop${flags}, or agi restart${flags}`,
      1
    );
  });
  if (!lock) return;
  stopping.signal.addEventListener('abort', () => void lock.stop(), { once: true });
  const ended = Promise.withResolvers<void>();
  served.push(ended.promise);
  try {
    await serveLocked(instance, tag, shared);
  } finally {
    await lock.release();
    ended.resolve();
  }
}

async function serveLocked(instance: Instance, tag: string, shared: Semaphore.Semaphore | undefined) {
  let scope = await readInstanceEnv(instance, makeHarnessChoice(values.provider), defaults, commandEnv);
  scope.env.AGENTGRAPH_DIR = await ensureInstanceGraph(instance, values.dir ?? scope.env.AGENTGRAPH_DIR);
  const opened = await openTracker(instance, scope);
  const { i } = opened;
  let { setup, current } = opened;
  const moved = setup.origin.local && (await ensureBase(i));
  if (moved) fail(moved, 1);
  const uncommitted = await whyGraphUncommitted(i, scope.env.AGENTGRAPH_DIR);
  if (uncommitted) console.error(tag + uncommitted);
  const connection = await connect(
    i,
    scope.env.AGENTGRAPH_DIR,
    'Nothing was driven.',
    !!setup.origin.local,
    scope,
    tag
  );
  scope = connection.scope;
  const drives = values.once ? undefined : startLoopDrives(shared);
  const sessions = Semaphore.makeUnsafe(1);
  const done = new AbortController();
  const halted = AbortSignal.any([stopping.signal, done.signal]);
  const selected = formatInstanceFlags(i.checkout, root, basename(i.dir));
  let why = '';
  const drive = (poll?: true) =>
    start(
      {
        graph: scope.env.AGENTGRAPH_DIR!,
        issue: 'all',
        data: i.data,
        instance: i,
        ...overrides,
        setup: { ...scope, tracker: setup },
        choice: makeHarnessChoice(connection.provider.name),
        sessions,
        ...(drives && { drives }),
        ...(poll && { poll }),
      },
      undefined,
      {},
      halted
    ).catch((e: unknown) => (halted.aborted ? [] : (console.error(...[tag].filter(Boolean), e), [])));
  const polling =
    drives &&
    !setup.origin.local &&
    (async () => {
      while (!halted.aborted) {
        await sleep(current.every * 60_000, undefined, { signal: halted }).catch(() => {});
        if (!why && !halted.aborted) await drive(true);
      }
    })();
  try {
    while (!stopping.signal.aborted) {
      const graph = scope.env.AGENTGRAPH_DIR!;
      current = await Effect.runPromise(
        settings.pipe(Effect.provideService(ConfigProvider.ConfigProvider, scope.config))
      );
      await writeIdleRunsCompressed(i.data, current.compress).catch((e: Error) =>
        console.error(`${tag}compressing idle runs failed: ${e.message}`)
      );
      why ||= await loadServedGraph(connection, graph, i, scope).then(
        () => '',
        (e: Error) => e.message
      );
      if (why) console.error(tag + why);
      else {
        const decided: RunRecord[] = await drive();
        const runs = [...new Map([...decided, ...(drives?.settled.splice(0) ?? [])].map(r => [r.id, r])).values()];
        printRuns(runs, tag);
        for (const issue of new Set((setup.origin.local ? runs : []).filter(isOnIssue).map(r => r.issue))) {
          const result = await writePullToRepo(i, issue, { auto: true }).catch((e: Error) => ({ why: e.message }));
          if (result)
            console.log(
              tag +
                ('why' in result
                  ? `#${issue} not written: ${result.why}; agi export ${issue} --as <branch>${selected}`
                  : `#${issue} in your repo as ${result.ref}`)
            );
        }
      }
      if (values.once || stopping.signal.aborted) break;
      const woken = new AbortController();
      const signal = AbortSignal.any([stopping.signal, woken.signal]);
      await Promise.race([
        sleep(current.every * 60_000, undefined, { signal }),
        ...(setup.origin.local ? [waitForTrackerEdit(i.tracker, signal)] : []),
      ]).catch(() => {});
      woken.abort();
      if (stopping.signal.aborted) break;
      const last = scope;
      try {
        scope = await applySettings(
          connection.provider,
          i,
          await readInstanceEnv(i, makeHarnessChoice(connection.provider.name), defaults, commandEnv)
        );
      } catch (e) {
        scope = last;
        console.error(`${tag}the settings did not refresh, the next pass keeps the last: ${(e as Error).message}`);
      }
      try {
        const moved = setup.origin.local && (await ensureBase(i));
        if (moved) throw new Error(moved);
        scope.env.AGENTGRAPH_DIR = await ensureInstanceGraph(i, values.dir ?? scope.env.AGENTGRAPH_DIR);
        ({ setup } = await openTracker(i, scope));
        why = '';
      } catch (e) {
        why = (e as Error).message;
      }
    }
  } finally {
    done.abort();
    await polling;
    await drives?.stop();
  }
}

async function showAll(i: Instance, tracker: Tracker['Service']) {
  const runs = await listRuns(i.data);
  const lines = [
    ...(scope.env.AGENTGRAPH_TRACKER === 'github'
      ? await Effect.runPromise(
          readInstallationReach({
            repo: scope.env.AGENTGRAPH_REPO!,
            id: scope.env.AGENTGRAPH_APP_ID!,
            key: Redacted.make(scope.env.AGENTGRAPH_APP_KEY!),
          })
        )
      : []),
    ...findRunsWaitingOnPeople(runs).flatMap(run =>
      formatNextSteps(run, scope.env.AGENTGRAPH_TRACKER === 'github' ? scope.env.AGENTGRAPH_REPO : undefined, selected)
    ),
    ...(await formatRunnerErrors(i.data, runs)),
  ];
  console.log(lines.length ? `Needs you\n${lines.join('\n')}\n` : 'Nothing needs you\n');
  console.log(formatIssueList(await Effect.runPromise(tracker.issues())));
}

async function showIssue(tracker: Tracker['Service'], issue: number, i: Instance) {
  const pull = trackerSetup.origin.local ? await findPull(i.tracker, issue) : undefined;
  for (const k of new Set([issue, pull?.number ?? issue])) {
    const t = await Effect.runPromise(tracker.issue(k)).catch((e: Error) => fail(e.message, 1));
    const diff = join(findIssueDir(i.tracker, k), 'diff.patch');
    console.log(formatIssueTimeline(t, existsSync(diff) ? readFileSync(diff, 'utf8') : ''));
  }
  for (const line of await formatRunnerErrors(i.data, await listRuns(i.data, { issue }))) console.log(line);
}

async function showInstances(root: string) {
  const all = findInstances(root);
  if (all.length === 0) console.log(`no instances under ${root}`);
  for (const i of all) {
    const waiting = findRunsWaitingOnPeople(await listRuns(i.data)).flatMap(run =>
      formatNextSteps(
        run,
        i.trackerName === 'github' ? i.repo : undefined,
        formatInstanceFlags(i.checkout, root, basename(i.dir))
      )
    );
    console.log(`${i.checkout}${existsSync(i.checkout) ? '' : ' (gone)'}  ${i.dir}`);
    for (const line of waiting) console.log(`  ${line}`);
  }
}
