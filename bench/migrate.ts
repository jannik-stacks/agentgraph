import { execFileSync } from 'node:child_process';
import { constants, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Effect } from 'effect';
import {
  appendBenchResults,
  bots,
  writeReferenceRun,
  readBenchCase,
  readBenchSetupLabels,
  readSlotRun,
  type Tests,
  makeBenchResults,
  makeBenchJudgeResult,
  type JudgedVerdict,
} from '../bin/bench.ts';
import { readFileOrEmpty } from '../bin/resume.ts';
import { writeImportedRun } from '../src/instance.ts';
import { getRounded } from '../src/stats.ts';
import { writeFileAtomic } from '../src/store.ts';
import { readRunLabels, writeRunLabels } from '../src/labels.ts';
import { type BenchInput, getBenchSlot, readAttemptRun, readBenchAttempts, type readDataUsage } from './runs.ts';
import type { TokenCounts } from '../src/prices.ts';

const version = 'migrated';
const leftOut = new Set(['work', 'homes', 'scratch']);
const clone = { recursive: true, mode: constants.COPYFILE_FICLONE };

const readJson = <T>(file: string) => JSON.parse(readFileOrEmpty(file) || 'null') as T | null;

const isDir = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;

const findCaseIds = (dir: string) => readdirSync(dir).filter(name => existsSync(join(dir, name, 'human')));

const findPointDirs = (dir: string, depth = 3): string[] =>
  existsSync(join(dir, 'point.json')) || (existsSync(join(dir, 'log.jsonl')) && findCaseIds(dir).length)
    ? [dir]
    : depth
      ? readdirSync(dir)
          .filter(
            name => !name.startsWith('.') && !['cases', 'engine', 'logs'].includes(name) && isDir(join(dir, name))
          )
          .flatMap(name => findPointDirs(join(dir, name), depth - 1))
      : [];

const readPoint = (dir: string) => {
  const p =
    readJson<
      Partial<Record<'harness' | 'model' | 'set' | 'engine' | 'at', string>> & {
        repeat?: number;
        labels?: Record<string, string>;
        graphs?: Record<string, string>;
        hubs?: Record<string, string>;
      }
    >(join(dir, 'point.json')) ?? {};
  return {
    harness: p.harness ?? 'opencode',
    model: p.model ?? 'smart',
    repeat: p.repeat ?? 1,
    set: p.set ?? basename(dir),
    engine: p.engine,
    at: p.at ?? '',
    labels: p.labels ?? {},
    graphs: p.graphs ?? p.hubs ?? {},
  };
};

const findNamesWithin = (dir: string, name: RegExp) =>
  existsSync(dir) ? readdirSync(dir).flatMap(n => (name.test(n) ? [join(dir, n)] : [])) : [];

const findEarlierAttempts = (final: string) => {
  return [
    ...findNamesWithin(dirname(final), new RegExp(`^${basename(final)}\\.\\d+$`)).toSorted(
      (a, b) => Number(a.split('.').pop()) - Number(b.split('.').pop())
    ),
    ...findNamesWithin(join(dirname(final), '.attic'), new RegExp(`^${basename(final)}-\\d{4}-`)).toSorted(),
  ];
};

type SavedUsage = Partial<ReturnType<typeof readDataUsage>> & { dir?: string; infra?: string };

const sumSavedUsage = (entries: SavedUsage[], dir: string) => {
  const sum = (get: (e: SavedUsage) => number | undefined) =>
    getRounded(entries.reduce((n, e) => n + (get(e) ?? 0), 0));
  const tokens: Record<string, TokenCounts> = {};
  for (const e of entries)
    for (const [model, t] of Object.entries(e.tokens ?? {})) {
      const total = (tokens[model] ??= { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
      for (const k of ['input', 'cacheRead', 'cacheWrite', 'output'] as const) total[k] += t[k];
    }
  return {
    sessions: sum(e => e.sessions),
    usd: sum(e => e.usd),
    checkUsd: sum(e => e.checkUsd),
    ms: sum(e => e.ms),
    tokens,
    split: {
      agent: sum(e => e.split?.agent),
      tools: sum(e => e.split?.tools),
      setup: sum(e => e.split?.setup),
      checks: sum(e => e.split?.checks),
      infra: sum(e => (e.infra && e.dir !== dir ? e.ms : 0)),
    },
  };
};

const whyInfra = (meta: { infra?: string; status?: string }) =>
  (meta.infra === 'empty diff' ? undefined : meta.infra) ??
  (meta.status === 'running' ? 'run did not finish' : undefined);

const copyAttempt = async (from: string, at: string, c: ReturnType<typeof readBenchCase>, repo: string) => {
  mkdirSync(at, { recursive: true });
  for (const [src, dst] of [
    ['graph', 'graph'],
    ['hub', 'graph'],
    ['tracker', 'tracker'],
    ['forge/origin.git', 'tracker/origin.git'],
    ['diff.patch', 'change.patch'],
  ] as const)
    if (existsSync(join(from, src)) && !existsSync(join(at, dst))) cpSync(join(from, src), join(at, dst), clone);
  if (existsSync(join(from, 'data')))
    cpSync(join(from, 'data'), join(at, 'data'), {
      ...clone,
      filter: src => !(leftOut.has(basename(src)) && resolve(src, '..') === resolve(from, 'data')),
    });
  if (readAttemptRun(at)) return false;
  const tracker = join(at, 'tracker');
  rmSync(tracker, { recursive: true, force: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(tracker, 'origin.git')]);
  const change = readFileOrEmpty(join(at, 'change.patch'));
  await writeImportedRun({ repo, tracker, data: join(at, 'data') }, change.trim() ? join(at, 'change.patch') : c.base, {
    version,
    from: c.base,
  });
  return true;
};

const writeScores = async (
  found: NonNullable<ReturnType<typeof readSlotRun>>,
  c: ReturnType<typeof readBenchCase>,
  root: string,
  arm: string,
  labels: Record<string, string>
) => {
  const s = readJson<Tests & { image?: string }>(join(root, arm, 'score.json'));
  if (!s) return;
  const base = arm === 'base' ? undefined : readJson<Tests>(join(root, 'base', 'score.json'));
  await appendBenchResults(
    found,
    makeBenchResults(
      { ...c, ...(s.image && { image: s.image }) },
      s,
      readFileOrEmpty(join(root, arm, 'diff.patch')),
      labels,
      base ?? undefined
    ),
    version
  );
};

const findJudgeFiles = (root: string, arm: string, pattern: RegExp) =>
  (existsSync(join(root, 'judge')) ? readdirSync(join(root, 'judge')) : [])
    .filter(pair => pair.split('-').includes(arm) && pair.split('-').includes('human'))
    .flatMap(pair =>
      readdirSync(join(root, 'judge', pair))
        .filter(name => pattern.test(name))
        .map(name => join(root, 'judge', pair, name))
    );

const writeJudge = async (
  found: NonNullable<ReturnType<typeof readSlotRun>>,
  root: string,
  arm: string,
  human: string
) => {
  const verdicts = findJudgeFiles(root, arm, /^[a-z0-9]+\.json$/).flatMap(f => readJson<JudgedVerdict>(f) ?? []);
  if (!verdicts.length) return;
  const usd = findJudgeFiles(root, arm, /\.cost\.json$/).reduce(
    (n, f) => n + (readJson<{ usd?: number }>(f)?.usd ?? 0),
    0
  );
  await appendBenchResults(found, [makeBenchJudgeResult(verdicts, arm, human)], version, getRounded(usd));
};

const writeSlot = async (
  set: string,
  input: BenchInput,
  done: (slot: string) => boolean,
  build: (draft: string) => Promise<void>
) => {
  const slot = getBenchSlot(set, input);
  const staging = join(set, 'runs', '.migrating');
  const draft = getBenchSlot(staging, input);
  const replaced = `${draft}.replaced`;
  if (!existsSync(slot) && existsSync(replaced)) renameSync(replaced, slot);
  rmSync(replaced, { recursive: true, force: true });
  if (done(slot)) return;
  rmSync(draft, { recursive: true, force: true });
  if (existsSync(slot)) cpSync(slot, draft, clone);
  await build(staging);
  if (existsSync(slot)) renameSync(slot, replaced);
  renameSync(draft, slot);
  rmSync(replaced, { recursive: true, force: true });
};

const hasEngine = (engine: string | undefined) => (slot: string) =>
  readBenchAttempts(slot).some(at => {
    const found = readAttemptRun(at);
    return !engine || (found && readRunLabels(found.data, found.run.id).engine === engine);
  });

const migrateReferences = async (
  root: string,
  c: ReturnType<typeof readBenchCase>,
  set: string,
  repo: string,
  labels: Record<string, string>
) => {
  for (const arm of ['base', 'human']) {
    if (!existsSync(join(root, arm, 'score.json'))) continue;
    const input = { case: c.id, arm, repeat: 1 };
    await writeSlot(set, input, existsSync, async draft => {
      await writeReferenceRun(arm, c.dir, draft, repo, 1);
      const found = readSlotRun(getBenchSlot(draft, input))!;
      await writeScores(found, c, root, arm, labels);
      const valid = arm === 'human' && readJson<{ invalid?: string }>(join(root, 'valid.json'));
      if (valid)
        await appendBenchResults(
          found,
          [{ check: 'bench/valid', pass: !valid.invalid, ...(valid.invalid && { findings: valid.invalid }) }],
          version
        );
    });
  }
};

const migrateArm = async (
  root: string,
  c: ReturnType<typeof readBenchCase>,
  set: string,
  repo: string,
  p: ReturnType<typeof readPoint>,
  arm: string,
  labels: Record<string, string>
) => {
  const final = join(root, arm);
  const meta = readJson<{ answers?: number } & Parameters<typeof whyInfra>[0] & { ms?: number }>(
    join(final, 'meta.json')
  );
  if (!meta) return;
  const input: BenchInput = {
    case: c.id,
    arm,
    repeat: p.repeat,
    point: `${p.harness}:${p.model}`,
    ...(p.graphs[arm] && { graph: p.graphs[arm] }),
  };
  const saved = readJson<{ attempts?: SavedUsage[] }>(join(final, 'usage.json'));
  const froms = [...findEarlierAttempts(final), final];
  const findSavedUsage = (from: string) =>
    saved?.attempts?.filter(
      a => a.dir === relative(root, from) || (from === final && !froms.some(f => a.dir === relative(root, f)))
    ) ?? [];
  await writeSlot(set, input, hasEngine(p.engine), async draft => {
    const slot = getBenchSlot(draft, input);
    const first = readBenchAttempts(slot).length;
    for (const [n, from] of froms.entries()) {
      const at = join(slot, String(first + n + 1));
      const imported = await copyAttempt(from, at, c, repo);
      const { run, data } = readAttemptRun(at)!;
      writeFileAtomic(join(data, run.id, 'run.json'), {
        ...run,
        meta: {
          ...run.meta,
          engine: {
            ...(run.meta?.engine as object | undefined),
            origin: { plugin: 'bench', version, job: p.set, input },
          },
        },
      });
      await Effect.runPromise(
        writeRunLabels(data, run.id, {
          ...p.labels,
          case: c.id,
          arm,
          harness: p.harness,
          model: p.model,
          repeat: String(p.repeat),
          set: p.set,
          ...(p.engine && { engine: p.engine }),
          ...(p.graphs[arm] && { graph: p.graphs[arm].slice(0, 12) }),
        })
      );
      const m = from === final ? meta : (readJson<typeof meta>(join(from, 'meta.json')) ?? {});
      const why = whyInfra(m);
      const entries = findSavedUsage(from);
      const usage =
        (imported &&
          (entries.length
            ? sumSavedUsage(entries, relative(root, from))
            : readJson<SavedUsage>(join(from, 'usage.json')))) ||
        {};
      const ms = usage.ms ?? m.ms;
      await appendBenchResults(
        readSlotRun(slot)!,
        [
          {
            check: 'bench/arm',
            pass: !why,
            ...(why && { findings: why }),
            value: {
              ...(typeof ms === 'number' && { ms }),
              ...(from === final && { answers: meta.answers ?? 0 }),
              ...(Object.keys(usage).length && { usage }),
            },
          },
        ],
        version
      );
    }
    if (whyInfra(meta)) return;
    const found = readSlotRun(slot)!;
    await writeScores(found, c, root, arm, labels);
    const human = readSlotRun(getBenchSlot(set, { case: c.id, arm: 'human', repeat: 1 }));
    if (human) await writeJudge(found, root, arm, human.run.id);
  });
};

export const copyOldBenchRuns = async (old: string, set: string, repos: string) => {
  if (!existsSync(join(set, 'cases'))) cpSync(join(old, 'cases'), join(set, 'cases'), clone);
  if (!existsSync(join(set, 'set.json')) && existsSync(join(old, 'set.json')))
    cpSync(join(old, 'set.json'), join(set, 'set.json'));
  for (const { dir, p } of findPointDirs(old)
    .map(dir => ({ dir, p: readPoint(dir) }))
    .toSorted((a, b) => a.p.at.localeCompare(b.p.at))) {
    for (const id of findCaseIds(dir)) {
      const caseDir = join(set, 'cases', id);
      if (!existsSync(join(caseDir, 'case.json'))) {
        console.log(`skip ${id}: no case in ${set}/cases`);
        continue;
      }
      const c = readBenchCase(caseDir);
      const repo = join(repos, c.repo.split('/').pop()!);
      const labels = readBenchSetupLabels(repo, c.base);
      await migrateReferences(join(dir, id), c, set, repo, labels);
      for (const arm of bots) await migrateArm(join(dir, id), c, set, repo, p, arm, labels);
      console.log(`migrated ${dir} ${id}`);
    }
  }
};

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { repos: { type: 'string', default: join(process.env.HOME ?? '', '.agentgraph/tune/repos') } },
  });
  const [old, set] = positionals;
  if (!old || !set) {
    console.error('usage: node bench/migrate.ts <old bench dir> <set> [--repos dir]');
    process.exit(2);
  }
  await copyOldBenchRuns(resolve(old), resolve(set), resolve(values.repos));
}
