import { constants, cpSync, existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Effect } from 'effect';
import {
  appendBenchResults,
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
import { getRunOrigin } from '../src/meta.ts';
import { getRounded } from '../src/stats.ts';
import { writeFileAtomic } from '../src/store.ts';
import { writeRunLabels } from '../src/labels.ts';
import { type BenchInput, getBenchSlot, readAttemptRun } from './runs.ts';

const version = 'migrated';
const bots = ['v2', 'floor'];
const leftOut = new Set(['work', 'homes', 'scratch']);

type Score = Tests & { image?: string; answers?: number; attempts?: { dir: string; ms: number; infra?: string }[] };
type Point = {
  harness: string;
  model: string;
  repeat: number;
  set?: string;
  engine?: string;
  labels?: Record<string, string>;
  graphs?: Record<string, string>;
  hubs?: Record<string, string>;
};

const readJson = <T>(file: string) => JSON.parse(readFileOrEmpty(file) || 'null') as T | null;

const isDir = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;

const findPointDirs = (dir: string, depth = 3): string[] =>
  existsSync(join(dir, 'point.json'))
    ? [dir]
    : depth
      ? readdirSync(dir)
          .filter(
            name => !name.startsWith('.') && !['cases', 'engine', 'logs'].includes(name) && isDir(join(dir, name))
          )
          .flatMap(name => findPointDirs(join(dir, name), depth - 1))
      : [];

const copyAttempt = (from: string, at: string) => {
  if (existsSync(join(from, 'graph')))
    cpSync(join(from, 'graph'), join(at, 'graph'), { recursive: true, mode: constants.COPYFILE_FICLONE });
  if (existsSync(join(from, 'forge', 'origin.git')))
    cpSync(join(from, 'forge', 'origin.git'), join(at, 'tracker', 'origin.git'), {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
    });
  if (existsSync(join(from, 'data')))
    cpSync(join(from, 'data'), join(at, 'data'), {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
      filter: src => !(leftOut.has(basename(src)) && resolve(src, '..') === resolve(from, 'data')),
    });
  return readAttemptRun(at);
};

const writeScores = async (
  found: NonNullable<ReturnType<typeof readSlotRun>>,
  c: ReturnType<typeof readBenchCase>,
  s: Score,
  diff: string,
  labels: Record<string, string>,
  base?: Score | null
) => {
  await appendBenchResults(
    found,
    makeBenchResults({ ...c, ...(s.image && { image: s.image }) }, s, diff, labels, base ?? undefined),
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

const migrateReferences = async (root: string, caseDir: string, set: string, repo: string) => {
  const c = readBenchCase(caseDir);
  const labels = readBenchSetupLabels(repo, c.base);
  const base = readJson<Score>(join(root, 'base', 'score.json'));
  for (const arm of ['base', 'human']) {
    const slot = getBenchSlot(set, { case: c.id, arm, repeat: 1 });
    const s = readJson<Score>(join(root, arm, 'score.json'));
    if (!s || readSlotRun(slot)) continue;
    await writeReferenceRun(arm, caseDir, set, repo, 1);
    const found = readSlotRun(slot)!;
    await writeScores(
      found,
      c,
      s,
      readFileOrEmpty(join(root, arm, 'diff.patch')),
      labels,
      arm === 'base' ? undefined : base
    );
    const valid = arm === 'human' && readJson<{ invalid?: string; skipped?: string }>(join(root, 'valid.json'));
    if (valid)
      await appendBenchResults(
        found,
        [{ check: 'bench/valid', pass: !valid.invalid, ...(valid.invalid && { findings: valid.invalid }) }],
        version
      );
  }
};

const migrateArm = async (root: string, caseDir: string, set: string, repo: string, p: Point, arm: string) => {
  const c = readBenchCase(caseDir);
  const s = readJson<Score>(join(root, arm, 'score.json'));
  const meta = readJson<{ answers?: number; ms?: number; infra?: string }>(join(root, arm, 'meta.json'));
  if (!meta) return;
  const input: BenchInput = { case: c.id, arm, repeat: p.repeat, point: `${p.harness}:${p.model}` };
  const slot = getBenchSlot(set, input);
  if (readSlotRun(slot)) return;
  const tries = [
    ...(s?.attempts ?? []).filter(a => a.dir.startsWith('.attic/')).map(a => ({ from: join(root, a.dir), ...a })),
    { from: join(root, arm), dir: arm, ms: meta.ms ?? 0, ...(meta.infra && { infra: meta.infra }) },
  ];
  let found;
  for (const [n, t] of tries.entries()) {
    const at = join(slot, String(n + 1));
    const copied = copyAttempt(t.from, at);
    if (!copied) continue;
    const { run, data } = copied;
    const origin = getRunOrigin(run.meta);
    writeFileAtomic(join(data, run.id, 'run.json'), {
      ...run,
      meta: {
        ...run.meta,
        engine: {
          ...(run.meta?.engine as object | undefined),
          origin: { ...(origin as object | undefined), plugin: 'bench', input },
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
        ...(p.engine && { engine: p.engine }),
        ...(p.set && { set: p.set }),
        ...((p.graphs ?? p.hubs)?.[arm] && { graph: (p.graphs ?? p.hubs)![arm] }),
      })
    );
    found = { ...readAttemptRun(at)!, at };
    await appendBenchResults(
      found,
      [
        {
          check: 'bench/arm',
          pass: !t.infra,
          ...(t.infra && { findings: t.infra }),
          value: { ms: t.ms, ...(t.dir === arm && { answers: meta.answers ?? s?.answers ?? 0 }) },
        },
      ],
      version
    );
  }
  if (!found || meta.infra || !s) return;
  const base = readJson<Score>(join(root, 'base', 'score.json'));
  await writeScores(
    found,
    c,
    s,
    readFileOrEmpty(join(root, arm, 'diff.patch')),
    readBenchSetupLabels(repo, c.base),
    base
  );
  const human = readSlotRun(getBenchSlot(set, { case: c.id, arm: 'human', repeat: 1 }));
  if (human) await writeJudge(found, root, arm, human.run.id);
};

export const copyOldBenchRuns = async (old: string, set: string, repos: string) => {
  if (!existsSync(join(set, 'cases')))
    cpSync(join(old, 'cases'), join(set, 'cases'), { recursive: true, mode: constants.COPYFILE_FICLONE });
  if (!existsSync(join(set, 'set.json')) && existsSync(join(old, 'set.json')))
    cpSync(join(old, 'set.json'), join(set, 'set.json'));
  for (const dir of findPointDirs(old)) {
    const p = readJson<Point>(join(dir, 'point.json'))!;
    for (const id of readdirSync(dir).filter(name => existsSync(join(dir, name, 'human')))) {
      const caseDir = join(set, 'cases', id);
      if (!existsSync(join(caseDir, 'case.json'))) {
        console.log(`skip ${id}: no case in ${set}/cases`);
        continue;
      }
      const repo = join(repos, readBenchCase(caseDir).repo.split('/').pop()!);
      await migrateReferences(join(dir, id), caseDir, set, repo);
      for (const arm of bots) await migrateArm(join(dir, id), caseDir, set, repo, p, arm);
      console.log(`migrated ${basename(dir)} ${id}`);
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
