import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { readRunLabels } from '../src/labels.ts';
import { getRunOrigin } from '../src/meta.ts';
import { getListPriceUsd, isModelPriced, readPrices, type TokenCounts } from '../src/prices.ts';
import { getRounded } from '../src/stats.ts';
import { type CheckEntry, findLatestChecks } from '../src/trace.ts';
import type { RunRecord } from '../src/workflow.ts';
import type { ResultSheet } from '../src/results.ts';
import { readJsonlRows, readRecordSync } from '../src/store.ts';

export type BenchInput = {
  case: string;
  arm: string;
  repeat: number;
  point?: string;
  graph?: string;
  labels?: Record<string, string>;
};

export const referenceArms = ['base', 'human'];

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

export const getBenchSlot = (set: string, input: BenchInput) =>
  join(
    set,
    'runs',
    `${input.case}-${input.arm}-r${input.repeat}-${hash(JSON.stringify([input.case, input.arm, input.repeat, input.point ?? '', input.graph ?? '', ...(input.labels ? [Object.entries(input.labels).toSorted()] : [])])).slice(0, 8)}`
  );

export const readBenchAttempts = (slot: string) =>
  (existsSync(slot) ? readdirSync(slot) : [])
    .filter(name => /^\d+$/.test(name))
    .map(Number)
    .toSorted((a, b) => a - b)
    .map(n => join(slot, String(n)));

export const makeNextAttempt = (slot: string) =>
  join(slot, String(Number(basename(readBenchAttempts(slot).at(-1) ?? '0')) + 1));

export const readAttemptRun = (at: string) => {
  const data = join(at, 'data');
  const runs = (existsSync(data) ? readdirSync(data) : []).flatMap(id => {
    const json = readRecordSync(join(data, id, 'run.json'));
    return json ? [JSON.parse(json) as RunRecord] : [];
  });
  const run = runs.toSorted((a, b) => a.started.localeCompare(b.started)).at(-1);
  return run && { run, data };
};

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

const readSlotChecks = (slot: string) => {
  const at = readBenchAttempts(slot).at(-1);
  const found = at && readAttemptRun(at);
  return found ? readLatestRunChecks(found.data, found.run.id) : new Map<string, CheckEntry>();
};

export const isBenchCaseValid = (set: string, id: string) =>
  readSlotChecks(getBenchSlot(set, { case: id, arm: 'human', repeat: 1 })).get('bench/valid')?.check.pass;

export const isBenchUnitDone = (set: string, input: BenchInput, judged: boolean) => {
  if (isBenchCaseValid(set, input.case) === false) return true;
  const checks = readSlotChecks(getBenchSlot(set, input));
  const armed = checks.get('bench/arm');
  if (!armed) return false;
  return !armed.check.pass || (checks.has('bench/hidden') && (!judged || checks.has('bench/judge')));
};

export const readDataUsage = (data: string) => {
  const ids = existsSync(data) ? readdirSync(data) : [];
  const traces = ids.flatMap(id => readJsonlRows(join(data, id, 'trace.jsonl')) as Record<string, unknown>[]);
  const checks = ids.flatMap(id => readJsonlRows(join(data, id, 'checks.jsonl')) as CheckEntry[]);
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

const skippedDirs = new Set([
  'cases',
  'graph',
  'homes',
  'index',
  'logs',
  'news',
  'node_modules',
  'repos',
  'scratch',
  'tracker',
  'tree',
  'work',
]);

const findRunFiles = (dir: string, depth: number): string[] => {
  if (existsSync(join(dir, 'run.json'))) return [join(dir, 'run.json')];
  if (!depth) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() && !e.name.startsWith('.') && !skippedDirs.has(e.name)
      ? findRunFiles(join(dir, e.name), depth - 1)
      : []
  );
};

const findBenchRuns = (roots: readonly string[]) =>
  [...new Set(roots.flatMap(root => (existsSync(root) ? findRunFiles(root, 9) : [])))].flatMap(file => {
    const run = JSON.parse(readRecordSync(file)) as RunRecord;
    const data = dirname(dirname(file));
    const at = dirname(data);
    const slotted =
      basename(data) === 'data' && /^\d+$/.test(basename(at)) && basename(dirname(dirname(at))) === 'runs';
    return [
      {
        run,
        data,
        at,
        slot: slotted ? dirname(at) : file,
        attempt: slotted ? Number(basename(at)) : 0,
        set: slotted ? dirname(dirname(dirname(at))) : undefined,
      },
    ];
  });

type Found = ReturnType<typeof findBenchRuns>[number];

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

type Findings = { critical: number; high: number };
type JudgeValue = { vsHuman: Record<string, number>; findings: Findings; against: Findings };

const isPass = (e: CheckEntry | undefined) =>
  e && !e.check.na && !e.check.empty ? (+e.check.pass as 0 | 1) : undefined;

const rowCache = new Map<string, { key: string; row: ReturnType<typeof readRow> }>();

const readRow = (found: Found, earlier: Found[], base?: Map<string, CheckEntry>, human?: Map<string, CheckEntry>) => {
  const { run, data, set } = found;
  const latest = readLatestRunChecks(data, run.id);
  const input = (getRunOrigin(run.meta)?.input ?? {}) as Partial<BenchInput>;
  const labels = readRunLabels(data, run.id);
  const id = input.case ?? labels.case ?? run.id;
  const arm = input.arm ?? labels.arm ?? run.workflow;
  const [harness, model] = input.point?.split(':') ?? [];
  const hidden = latest.get('bench/hidden');
  const armed = latest.get('bench/arm');
  const judged = latest.get('bench/judge')?.check.value as JudgeValue | undefined;
  const size = latest.get('bench/size')?.check.value as { files?: number } | undefined;
  const setup = latest.get('bench/setup')?.check.value as
    | { labels?: Record<string, string>; setup?: boolean }
    | undefined;
  const usage = [found, ...earlier].map(f => ({
    ...readDataUsage(f.data),
    ...(
      readLatestRunChecks(f.data, f.run.id).get('bench/arm')?.check.value as
        | { usage?: Pick<ReturnType<typeof readDataUsage>, 'sessions' | 'usd' | 'tokens'> }
        | undefined
    )?.usage,
  }));
  const tokens: Record<string, TokenCounts> = {};
  for (const u of usage)
    for (const [m, t] of Object.entries(u.tokens)) {
      const sum = (tokens[m] ??= { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
      for (const k of ['input', 'cacheRead', 'cacheWrite', 'output'] as const) sum[k] += t[k];
    }
  const total = (k: 'usd' | 'checkUsd' | 'sessions') => getRounded(usage.reduce((n, u) => n + u[k], 0));
  const armMs = (f: Found, u: (typeof usage)[number]) =>
    Number((readLatestRunChecks(f.data, f.run.id).get('bench/arm')?.check.value as { ms?: number })?.ms ?? u.ms);
  const ms = [found, ...earlier].reduce((n, f, i) => n + armMs(f, usage[i]!), 0);
  const split = {
    agent: usage.reduce((n, u) => n + u.split.agent, 0),
    tools: usage.reduce((n, u) => n + u.split.tools, 0),
    setup: usage.reduce((n, u) => n + u.split.setup, 0),
    checks: usage.reduce((n, u) => n + u.split.checks, 0),
    infra: earlier.reduce((n, f, i) => n + armMs(f, usage[i + 1]!), 0),
  };
  const infra =
    armed && !armed.check.pass ? armed.check.findings || 'infra' : setup?.setup === false ? 'setup fails' : undefined;
  const share = hidden?.check.share;
  const suite = isPass(base?.get('bench/suite')) === 0 ? undefined : isPass(latest.get('bench/suite'));
  return {
    labels: {
      ...labels,
      ...readCaseLabels(set, id),
      ...setup?.labels,
      ...(harness && model && { harness, model }),
      arm,
      ...(run.graph && { graph: labels.graph ?? run.graph.slice(0, 12) }),
      set: labels.set ?? (set ? basename(set) : ''),
      tests:
        (human ?? latest).get('bench/hidden') && !(human ?? latest).get('bench/hidden')!.check.na
          ? 'hidden'
          : 'judge-only',
    } as Record<string, string>,
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
    minutes: ms / 60_000,
    tokens,
    split,
    ...getBenchUsageCost({ usd: total('usd'), tokens }),
    checkUsd: getRounded(total('checkUsd') + [...latest.values()].reduce((n, e) => n + (e.later ? e.usd : 0), 0)),
    results: toResults(latest),
  };
};

const readCaseKey = (f: Found) => {
  const input = (getRunOrigin(f.run.meta)?.input ?? {}) as Partial<BenchInput>;
  return { key: JSON.stringify([f.set ?? '', input.case ?? '']), arm: input.arm };
};

export const readBenchRows = (roots: readonly string[]) => {
  const slots = [...Map.groupBy(findBenchRuns(roots), f => f.slot).values()].map(fs =>
    fs.toSorted((a, b) => b.attempt - a.attempt || b.run.started.localeCompare(a.run.started))
  );
  const refs = (arm: string) =>
    new Map(slots.flatMap(([f]) => (readCaseKey(f!).arm === arm ? [[readCaseKey(f!).key, f!] as const] : [])));
  const bases = refs('base');
  const humans = refs('human');
  const invalid = new Set(
    slots.flatMap(([f]) => {
      const valid = readCaseKey(f!).arm === 'human' && readLatestRunChecks(f!.data, f!.run.id).get('bench/valid');
      return valid && !valid.check.pass ? [readCaseKey(f!).key] : [];
    })
  );
  return slots.flatMap(([found, ...earlier]) => {
    const { key, arm } = readCaseKey(found!);
    if (invalid.has(key)) return [];
    const [base, human] = [bases.get(key), humans.get(key)];
    const hasArm = readLatestRunChecks(found!.data, found!.run.id).has('bench/arm');
    if (arm === 'control' || (found!.run.workflow !== 'import' && !hasArm)) return [];
    const files = [found!, ...earlier, ...(base ? [base] : []), ...(human ? [human] : [])].flatMap(f =>
      ['run.json', 'checks.jsonl', 'labels.jsonl', 'trace.jsonl'].map(
        n => statSync(join(f.data, f.run.id, n), { throwIfNoEntry: false })?.mtimeMs ?? 0
      )
    );
    const cacheKey = JSON.stringify(files);
    const cached = rowCache.get(found!.slot);
    if (cached?.key === cacheKey) return [cached.row];
    const row = readRow(
      found!,
      earlier,
      base && readLatestRunChecks(base.data, base.run.id),
      human && readLatestRunChecks(human.data, human.run.id)
    );
    rowCache.set(found!.slot, { key: cacheKey, row });
    return [row];
  });
};

export type BenchRow = ReturnType<typeof readBenchRows>[number];
