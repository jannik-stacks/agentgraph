import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { getRunOrigin } from '../src/meta.ts';
import { makeVersionLabels } from '../src/labels.ts';
import { getListPriceUsd, isModelPriced, readPrices, type TokenCounts } from '../src/prices.ts';
import { getRounded } from '../src/stats.ts';
import { findLatestChecks } from '../src/trace.ts';
import { findCheckFields, mergeCheckFields, type ResultSheet } from '../src/results.ts';
import { readJsonlRows, readRecordSync, writeFileAtomic } from '../src/store.ts';
import { getSha } from '../src/hash.ts';
import { readDirOrEmpty } from '../src/read.ts';
import { type EngineHost, makeEngineHost } from '../src/engine.ts';
import { readRealPath } from '../src/instance.ts';
import { type CheckEntry, type InstanceHosts, type RunRecord } from '../src/types.ts';

export type BenchInput = {
  case: string;
  arm: string;
  repeat: number;
  point?: string;
  graph?: string;
  labels?: Record<string, string>;
  attempt?: number;
};

export const referenceArms = ['base', 'human'];

export const getBenchSlot = (input: BenchInput) =>
  `${input.case}-${input.arm}-r${input.repeat}-${getSha(JSON.stringify([input.case, input.arm, input.repeat, input.point ?? '', input.graph ?? '', ...(input.labels ? [Object.entries(input.labels).toSorted()] : [])]), 8)}`;

export const findAttemptDir = (set: string, attempt: number) => join(set, 'attempts', String(attempt));

export const findSlotLock = (set: string, input: BenchInput) => join(set, 'locks', getBenchSlot(input));

const readBenchInput = (run: Pick<RunRecord, 'meta'>) =>
  (getRunOrigin(run.meta)?.input ?? undefined) as Partial<BenchInput> | undefined;

const readAttemptNumbers = (root: string) =>
  readDirOrEmpty(root)
    .filter(n => /^\d+$/.test(n))
    .map(Number);

export const makeBenchAttempt = (set: string, input: BenchInput) => {
  const root = join(set, 'attempts');
  mkdirSync(root, { recursive: true });
  for (;;) {
    const attempt = Math.max(0, ...readAttemptNumbers(root)) + 1;
    const at = findAttemptDir(set, attempt);
    try {
      mkdirSync(at);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw e;
    }
    const pinned = { ...input, attempt };
    writeFileAtomic(join(at, 'input.json'), pinned);
    return { at, input: pinned };
  }
};

export const readBenchSlots = (set: string) => {
  const data = join(set, 'data');
  const runs = new Map<number, RunRecord>();
  for (const { run } of makeSetHost([set]).readRuns(set)) {
    const attempt = readBenchInput(run)?.attempt;
    const was = attempt === undefined ? undefined : runs.get(attempt);
    if (attempt !== undefined && (!was || was.started.localeCompare(run.started) <= 0)) runs.set(attempt, run);
  }
  const root = join(set, 'attempts');
  const attempts = readAttemptNumbers(root)
    .toSorted((a, b) => a - b)
    .flatMap(attempt => {
      const input = JSON.parse(
        readRecordSync(join(root, String(attempt), 'input.json')) || 'null'
      ) as BenchInput | null;
      const run = runs.get(attempt);
      return input
        ? [{ slot: getBenchSlot(input), attempt, at: findAttemptDir(set, attempt), data, ...(run && { run }) }]
        : [];
    });
  return Map.groupBy(attempts, a => a.slot);
};

type BenchSlots = ReturnType<typeof readBenchSlots>;

export const readSlotRun = (set: string, input: BenchInput, slots: BenchSlots = readBenchSlots(set)) => {
  const last = slots.get(getBenchSlot(input))?.at(-1);
  return last?.run && { run: last.run, data: last.data, at: last.at };
};

export const readBenchRun = (data: string, id: string) =>
  JSON.parse(readRecordSync(join(data, id, 'run.json')) || 'null') as RunRecord | null;

export const readRunChange = (at: string, run: Pick<RunRecord, 'id' | 'startCommit'>) => {
  const r =
    run.startCommit &&
    spawnSync(
      'git',
      ['--git-dir', join(at, 'tracker', 'origin.git'), 'diff', run.startCommit, `refs/agentgraph/runs/${run.id}`],
      { encoding: 'utf8', maxBuffer: 1 << 28 }
    );
  return r && r.status === 0 ? r.stdout : readRecordSync(join(at, 'change.patch'));
};

export const readLatestRunChecks = (data: string, id: string) =>
  new Map(findLatestChecks(readJsonlRows(join(data, id, 'checks.jsonl')) as CheckEntry[]).map(e => [e.check.check, e]));

const readSlotChecks = (set: string, input: BenchInput, slots: BenchSlots) => {
  const found = readSlotRun(set, input, slots);
  return found ? readLatestRunChecks(found.data, found.run.id) : new Map<string, CheckEntry>();
};

export const isBenchCaseValid = (set: string, id: string, slots: BenchSlots = readBenchSlots(set)) =>
  readSlotChecks(set, { case: id, arm: 'human', repeat: 1 }, slots).get('bench/valid')?.check.pass;

export const isBenchRunDone = (
  set: string,
  input: BenchInput,
  judged: boolean,
  slots: BenchSlots = readBenchSlots(set)
) => {
  if (isBenchCaseValid(set, input.case, slots) === false) return true;
  const checks = readSlotChecks(set, input, slots);
  const armed = checks.get('bench/arm');
  if (!armed) return false;
  return !armed.check.pass || (checks.has('bench/hidden') && (!judged || checks.has('bench/judge')));
};

export const readRunUsage = (data: string, id: string) => {
  const traces = readJsonlRows(join(data, id, 'trace.jsonl')) as Record<string, unknown>[];
  const checks = readJsonlRows(join(data, id, 'checks.jsonl')) as CheckEntry[];
  const sessions = traces.flatMap(t => (t.session ? [t.session as { usd: number }] : []));
  const models: Record<string, string> = {};
  const tokens: Record<string, TokenCounts> = {};
  const split = { agent: 0, tools: 0, setup: 0, checks: 0 };
  for (const e of checks) if (e.item === undefined && !e.later) split.checks += e.check.ms ?? 0;
  const opened: Record<string, number> = {};
  const times: number[] = [];
  for (const t of traces) {
    const e = (t.event ?? {}) as Partial<Record<'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'ms', number>> & {
      type?: string;
      model?: string;
    };
    const key = String(t.key);
    split.setup += (t.setup as { ms?: number } | undefined)?.ms ?? 0;
    if (e.type === 'tool') split.tools += e.ms ?? 0;
    const when = Date.parse(String(t.at));
    if (Number.isFinite(when)) times.push(when);
    if (e.type === 'start') opened[key] = when;
    if (t.session && Number.isFinite(when - opened[key]!)) split.agent += when - opened[key]!;
    if (e.type === 'start' && e.model) models[key] = e.model;
    if (e.type !== 'usage') continue;
    const [read, write] = [e.cacheRead ?? 0, e.cacheWrite ?? 0];
    const sum = (tokens[models[key] ?? 'unknown'] ??= { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
    sum.input += (e.input ?? 0) - read - write;
    sum.cacheRead += read;
    sum.cacheWrite += write;
    sum.output += e.output ?? 0;
  }
  return {
    sessions: sessions.length,
    usd: getRounded(sessions.reduce((a, s) => a + s.usd, 0)),
    checkUsd: getRounded(checks.filter(e => !e.later).reduce((a, e) => a + e.usd, 0)),
    ms: times.length ? Math.max(...times) - Math.min(...times) : 0,
    tokens,
    split,
  };
};

const prices = readPrices();

export const getBenchUsageCost = (u: { usd?: number; tokens?: Record<string, TokenCounts> }, table = prices) => {
  const models = Object.keys(u.tokens ?? {});
  if (!models.length) return { usd: u.usd ?? 0, usdUncached: u.usd ?? 0 };
  const at = (uncached: boolean) =>
    getRounded(models.reduce((sum, m) => sum + (getListPriceUsd(table, [m], u.tokens![m]!, uncached) ?? 0), 0));
  const unpriced = models.filter(m => !isModelPriced(table, m));
  return { usd: at(false), usdUncached: at(true), ...(unpriced.length > 0 && { unpriced }) };
};

export const makeSetHost = (sets: readonly string[], hosts: InstanceHosts = {}) => {
  const seen = new Set<string>();
  return makeEngineHost(
    'bench',
    [
      ...Object.entries(hosts).flatMap(([name, host]) =>
        'why' in host ? [] : [{ name, data: host.data, instance: name, ...(host.checks && { checks: host.checks }) }]
      ),
      ...sets.map(set => ({ name: set, data: join(set, 'data') })),
    ].filter(({ data }) => !seen.has(readRealPath(data)) && !!seen.add(readRealPath(data)))
  );
};

export const findBenchRuns = (host: Pick<EngineHost, 'configs' | 'readRuns'>) =>
  host.configs.flatMap(config =>
    host.readRuns(config.name).map(({ run, data, labels, latest }) => {
      const input = readBenchInput(run);
      const set = input?.attempt !== undefined && basename(data) === 'data' ? dirname(data) : undefined;
      return {
        run,
        data,
        config,
        labels,
        at: set ? findAttemptDir(set, input!.attempt!) : dirname(data),
        slot: set ? join(set, getBenchSlot(input as BenchInput)) : `${config.name}/${run.id}`,
        attempt: input?.attempt ?? 0,
        set,
        latest: new Map(latest.map(e => [e.check.check, e])),
      };
    })
  );

type FoundRun = ReturnType<typeof findBenchRuns>[number];

const toResults = (latest: ReturnType<typeof readLatestRunChecks>): (typeof ResultSheet.Type.runs)[number]['results'] =>
  Object.fromEntries(
    [...latest.values()].map(e => [
      e.check.check,
      {
        at: e.at,
        pass: e.check.pass,
        ...(e.check.value && { value: e.check.value }),
        ...(e.check.share !== undefined && { share: e.check.share }),
        ...(e.check.empty && { empty: e.check.empty }),
        ...(e.check.na && { na: e.check.na }),
        ...(e.later && { later: e.later }),
      },
    ])
  );

const caseLabelKeys = ['repo', 'size', 'kind', 'bucket', 'filesBucket', 'area', 'issue'];

const readCaseLabels = (set: string | undefined, id: string): Record<string, string> => {
  const c = JSON.parse(readRecordSync(set ? join(set, 'cases', id, 'case.json') : '') || '{}') as Record<
    string,
    unknown
  >;
  return {
    ...(c.labels as Record<string, string>),
    ...Object.fromEntries(
      caseLabelKeys.flatMap(k => (c[k] === undefined || typeof c[k] === 'object' ? [] : [[k, String(c[k])]]))
    ),
    ...(c.repo !== undefined && {
      issue: Array.isArray(c.flags) && c.flags.includes('no-issue-pr-body') ? 'pr-body' : 'issue',
    }),
  };
};

const isPass = (e: CheckEntry | undefined) =>
  e && !e.check.na && !e.check.empty ? (+e.check.pass as 0 | 1) : undefined;

const rowCache = new Map<string, { key: string; row: ReturnType<typeof readRow> }>();

const readRow = (
  found: FoundRun,
  earlier: FoundRun[],
  base?: Map<string, CheckEntry>,
  human?: Map<string, CheckEntry>
) => {
  const { run, data, set, latest, labels, config } = found;
  const input = readBenchInput(run) ?? {};
  const id = input.case ?? labels.case ?? run.id;
  const arm = input.arm ?? labels.arm ?? run.workflow;
  const [harness, model] = input.point?.split(':') ?? [];
  const hidden = latest.get('bench/hidden');
  const armed = latest.get('bench/arm');
  const judged = latest.get('bench/judge')?.check.value as
    | (Record<'findings' | 'against', Record<'critical' | 'high', number>> & { vsHuman: Record<string, number> })
    | undefined;
  const size = latest.get('bench/size')?.check.value as { files?: number } | undefined;
  const setup = latest.get('bench/setup')?.check.value as
    | { labels?: Record<string, string>; setup?: boolean }
    | undefined;
  const usage = [found, ...earlier].map(f => {
    const value = f.latest.get('bench/arm')?.check.value as
      | { ms?: number; usage?: Partial<ReturnType<typeof readRunUsage>> }
      | undefined;
    const u = { ...readRunUsage(f.data, f.run.id), ...value?.usage };
    return { ...u, ms: value?.ms ?? u.ms, split: { infra: 0, ...u.split } };
  });
  const tokens: Record<string, TokenCounts> = {};
  for (const u of usage)
    for (const [m, t] of Object.entries(u.tokens)) {
      const sum = (tokens[m] ??= { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
      for (const k of ['input', 'cacheRead', 'cacheWrite', 'output'] as const) sum[k] += t[k];
    }
  const total = (k: 'usd' | 'checkUsd' | 'sessions' | 'ms') => getRounded(usage.reduce((n, u) => n + u[k], 0));
  const part = (k: keyof (typeof usage)[number]['split']) => usage.reduce((n, u) => n + u.split[k], 0);
  const split = {
    agent: part('agent'),
    tools: part('tools'),
    setup: part('setup'),
    checks: part('checks'),
    infra: part('infra') + usage.slice(1).reduce((n, u) => n + u.ms, 0),
  };
  const infra =
    armed && !armed.check.pass ? armed.check.findings || 'infra' : setup?.setup === false ? 'setup fails' : undefined;
  const share = hidden?.check.share;
  const suite = isPass(base?.get('bench/suite')) === 0 ? undefined : isPass(latest.get('bench/suite'));
  return {
    labels: {
      ...makeVersionLabels(run.versions),
      ...labels,
      ...readCaseLabels(set, id),
      ...setup?.labels,
      ...(harness && model && { harness, model }),
      arm,
      ...(run.graph && { graph: labels.graph ?? run.graph.slice(0, 12) }),
      set: labels.set ?? (set ? basename(set) : ''),
      ...(config.instance !== undefined && { instance: config.instance || config.name }),
      ...(input.case !== undefined && {
        tests:
          (human ?? latest).get('bench/hidden') && !(human ?? latest).get('bench/hidden')!.check.na
            ? 'hidden'
            : 'judge-only',
      }),
    } as Record<string, string>,
    ...(config.instance !== undefined && { instance: config.instance }),
    case: id,
    repeat: input.repeat ?? 1,
    run: run.id,
    data,
    at: found.at,
    ...(infra && { infra }),
    ...(hidden?.check.na && { skipped: hidden.check.findings || 'no hidden tests' }),
    ...(!infra && !referenceArms.includes(arm) && size?.files === 0 && { outcome: 'no-change' as const }),
    ...(isPass(hidden) !== undefined && { hidden: isPass(hidden)! }),
    ...(share !== undefined && { hiddenShare: share }),
    ...(suite !== undefined && { suite }),
    ...(isPass(latest.get('bench/typecheck')) !== undefined && { typecheck: isPass(latest.get('bench/typecheck'))! }),
    vsHuman: judged?.vsHuman ?? {},
    findings: judged?.findings ?? { critical: 0, high: 0 },
    ...(judged?.against && { against: judged.against }),
    answers: Number((armed?.check.value as { answers?: number } | undefined)?.answers ?? 0),
    minutes: total('ms') / 60_000,
    tokens,
    split,
    ...getBenchUsageCost({ usd: total('usd'), tokens }),
    checkUsd: getRounded(total('checkUsd') + [...latest.values()].reduce((n, e) => n + (e.later ? e.usd : 0), 0)),
    results: toResults(latest),
  };
};

const splitFinishedRuns = (fs: FoundRun[]) => {
  const groups: FoundRun[][] = [[]];
  for (const [i, f] of fs.entries()) {
    groups.at(-1)!.unshift(f);
    if (i < fs.length - 1 && f.latest.has('bench/hidden')) groups.push([]);
  }
  return groups as [FoundRun, ...FoundRun[]][];
};

export const readBenchRows = (host: Pick<EngineHost, 'configs' | 'readRuns'>) => {
  const slots = [...Map.groupBy(findBenchRuns(host), f => f.slot).values()]
    .flatMap(fs =>
      splitFinishedRuns(fs.toSorted((a, b) => a.attempt - b.attempt || a.run.started.localeCompare(b.run.started)))
    )
    .map(([found, ...earlier]) => {
      const input = readBenchInput(found.run) ?? {};
      return {
        found,
        earlier,
        key: JSON.stringify([found.set ?? '', input.case ?? '']),
        arm: input.arm,
      };
    });
  const refs = (arm: string) => new Map(slots.flatMap(s => (s.arm === arm ? [[s.key, s] as const] : [])));
  const bases = refs('base');
  const humans = refs('human');
  const invalid = new Set(
    [...humans.values()].flatMap(s => (s.found.latest.get('bench/valid')?.check.pass === false ? [s.key] : []))
  );
  return slots.flatMap(({ found, earlier, key, arm }) => {
    if (invalid.has(key)) return [];
    const [base, human] = [bases.get(key), humans.get(key)];
    if (
      arm === 'control' ||
      (found.config.instance === undefined && found.run.workflow !== 'import' && !found.latest.has('bench/arm'))
    )
      return [];
    const files = [found, ...earlier, ...(base ? [base.found] : []), ...(human ? [human.found] : [])].flatMap(f =>
      ['run.json', 'checks.jsonl', 'labels.jsonl', 'trace.jsonl'].map(
        n => statSync(join(f.data, f.run.id, n), { throwIfNoEntry: false })?.mtimeMs ?? 0
      )
    );
    const cacheKey = JSON.stringify(files);
    const cached = rowCache.get(join(found.data, found.run.id));
    if (cached?.key === cacheKey) return [cached.row];
    const row = readRow(found, earlier, base?.found.latest, human?.found.latest);
    rowCache.set(join(found.data, found.run.id), { key: cacheKey, row });
    return [row];
  });
};

export type BenchRow = ReturnType<typeof readBenchRows>[number];

export const readBenchData = (host: Pick<EngineHost, 'configs' | 'readRuns'>) => {
  const rows = readBenchRows(host);
  return {
    rows,
    ...mergeCheckFields(
      host.configs.map(c =>
        findCheckFields(
          rows.filter(row => row.data === c.data),
          c.checks
        )
      )
    ),
  };
};
