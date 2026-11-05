/**
 * Hill-climbs a graph on one repo's replayed pull requests: each step evaluates candidate graphs with the bench and keeps
 * one only when it beats the incumbent on the select cases (fit plus validate).
 * Usage: node bin/tune.ts init <repo> --cases <dir> --splits <file> --repos <dir> --point opencode:luna [--name t1]
 *        node bin/tune.ts step <tune dir> [--k 3] [--proposers retro,history,manual] [--parallel 6] [--proposer-model gpt-6.1-sol]
 *        node bin/tune.ts run <tune dir> --iterations 8 [--max-codex 25] [--max-claude-5h 40] [--max-claude-week 12]
 *        node bin/tune.ts checkpoint <tune dir>
 *        node bin/tune.ts propose <tune dir> --from <graph dir> --why <text> [--as manual|skill]
 *        node bin/tune.ts status <tune dir or root> [--max-codex 25] [--max-claude-5h 40] [--max-claude-week 12]
 * Tunes live in <root>/<repo>/<name>; the root is AGENTGRAPH_TUNE, by default ~/.agentgraph/tune.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { Effect } from 'effect';
import { presets, quality, random } from '../studio/src/bench/score.ts';
import { getMean, getRounded, sum } from '../src/stats.ts';
import { propose as proposeWith, readVariantRows } from '../tune/propose.ts';
import { codexUsed, makeBenchInput, pickBenchTestCommands, readBenchCase } from './bench.ts';
import {
  type BenchRow,
  findSlotLock,
  getBenchSlot,
  isBenchCaseValid,
  isBenchRunDone,
  readBenchSlots,
} from '../bench/runs.ts';
import { runLogged, runQueue } from '../bench/start-runs.ts';
import { writeRunLabels } from '../src/labels.ts';
import { writeFileAtomic } from '../src/store.ts';
import {
  agentgraphDir,
  appendJsonl,
  claim,
  readJsonl,
  onStop,
  release,
  readFileOrEmpty,
  waitWhileServicesDown,
} from './resume.ts';
import { isLockedByOtherProcess } from '../src/owner.ts';
import {
  type Eval,
  type Flip,
  getTuneLabel,
  readTuneSteps,
  type Split,
  type TuneStep,
  type Variant,
  writeVariantDecision,
  writeVariantRun,
  writeVariantTest,
} from '../tune/runs.ts';

type Proposer = Variant['proposer'];

type Tune = {
  repo: string;
  /** The release tag at init, like `agentgraph-v0.2.0`, else the commit; every run needs its `src` tree. */
  engine: string;
  point: string;
  cases: Record<string, Split>;
  preset: 'hidden' | 'composite';
  keep: Partial<{ runs: number; drops: number; save: number }>;
  clone: string;
};
type Row = BenchRow;
/** The latest reading of a usage window in percent, and the points used since the first, across window resets. */
type Reading = { now: number; used: number };
type Budget = { codex?: Reading; claude?: { fiveHour?: Reading; week?: Reading } };

const tuneRoot = () => process.env.AGENTGRAPH_TUNE ?? join(homedir(), '.agentgraph/tune');
const pad = (n: number) => String(n).padStart(3, '0');

/** The tune's settings, its decided variants in order and the variants under evaluation, read from its control runs. */
export const tuneRows = (dir: string) => {
  const tune = readFileOrEmpty(join(dir, 'tune.json'));
  if (!tune) throw new Error(`${dir} has no tune.json`);
  return { tune: JSON.parse(tune) as Tune, ...readTuneSteps(dir) };
};

const subdirs = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap(e =>
        e.isDirectory() && !e.name.startsWith('.') ? [e.name] : []
      )
    : [];

/** The mean gain of `b` over `a` case by case, the share of bootstrap draws above 0 and its 95% interval. */
export const paired = (a: number[], b: number[], n = 2000) => {
  if (a.length !== b.length) throw new Error('paired scores must have the same length');
  const d = b.map((x, i) => x - a[i]!);
  if (!d.length) return { delta: 0, pUp: 0, ci: [0, 0] as [number, number] };
  const next = random(1);
  const draws = Array.from({ length: n }, () => getMean(d.map(() => d[Math.floor(next() * d.length)]!))).sort(
    (x, y) => x - y
  );
  return {
    delta: getRounded(getMean(d)),
    pUp: getRounded(draws.filter(m => m > 0).length / n),
    ci: [getRounded(draws[Math.floor(n * 0.025)]!), getRounded(draws[Math.floor(n * 0.975)]!)] as [number, number],
  };
};

const keepOf = (t: Pick<Tune, 'keep'>) => ({ runs: 3, drops: 2, save: 0.15, ...t.keep });

/**
 * Per case, how the candidate's runs compare with the incumbent's. A case whose incumbent runs disagree is noise and
 * never flips; a flip is a win or loss once both sides have `runs` runs and none of them overlap.
 */
export const flipsOf = (inc: Record<string, number[]>, cand: Record<string, number[]>, runs: number) => {
  const out: Record<string, Flip> = {};
  for (const [c, x] of Object.entries(cand)) {
    const b = inc[c] ?? [];
    if (!b.length || !x.length || Math.max(...b) - Math.min(...b) >= 0.5) continue;
    const d = getMean(x) - getMean(b);
    if (Math.abs(d) < 0.5) continue;
    const apart = d > 0 ? Math.min(...x) - Math.max(...b) : Math.min(...b) - Math.max(...x);
    const held = b.length >= runs && x.length >= runs && apart >= 0.5;
    out[c] = d > 0 ? (held ? 'win' : 'up') : held ? 'loss' : 'down';
  }
  return out;
};

const count = (e: Eval | undefined, ...of: Flip[]) => Object.values(e?.flips ?? {}).filter(f => of.includes(f)).length;

/** The cost the candidate saves for sure: at least `save` of usd or minutes per run, with 95% of draws below. */
export const cheaper = (t: Pick<Tune, 'keep'>, e: Eval) =>
  (['usd', 'minutes'] as const).filter(k => (e.saved?.[k].share ?? 0) >= keepOf(t).save && e.saved![k].pDown >= 0.95);

/**
 * Out when the screen drops `drops` cases and lifts none. Kept when more select cases win than lose, or when no case
 * drops and it costs less in usd or minutes.
 */
export const decide = (t: Pick<Tune, 'keep'>, screen: Eval, full?: Eval): TuneStep['verdict'] =>
  count(screen, 'down', 'loss') >= keepOf(t).drops && !count(screen, 'up', 'win')
    ? 'screened-out'
    : full && count(full, 'win') > count(full, 'loss')
      ? 'kept'
      : full && !count(full, 'down', 'loss') && cheaper(t, full).length
        ? 'kept'
        : 'discarded';

const ids = (t: Tune, ...splits: Split[]) =>
  Object.keys(t.cases)
    .filter(id => splits.includes(t.cases[id]!))
    .sort();

const scores = (rows: Row[], preset: Tune['preset']) => {
  const w = preset === 'hidden' ? { ...presets['hidden tests only']!, suite: 0.15 } : presets.composite!;
  const out = new Map<
    string,
    { qs: number[]; paid: number[]; took: number[]; runs: number; usd: number; min: number }
  >();
  for (const r of rows.filter(r => r.labels.arm === 'v2')) {
    const s = out.get(r.case) ?? { qs: [], paid: [], took: [], runs: 0, usd: 0, min: 0 };
    const q = r.infra ? undefined : quality(r, w);
    if (q !== undefined) {
      s.qs.push(q);
      s.paid.push(r.usd ?? 0);
      s.took.push(r.minutes);
    }
    out.set(r.case, { ...s, runs: s.runs + 1, usd: s.usd + (r.usd ?? 0), min: s.min + r.minutes });
  }
  return out;
};
type Scores = ReturnType<typeof scores>;
const qsOf = (s: Scores, cases: string[]) => Object.fromEntries(cases.map(c => [c, s.get(c)?.qs ?? []]));
const findUnscoredCases = (cases: string[], mine: Scores, incumbent?: Scores) =>
  cases.filter(c => !mine.get(c)?.qs.length || (incumbent !== undefined && !incumbent.get(c)?.qs.length));

const evalOf = (
  variant: string,
  split: Split,
  cases: string[],
  mine: Scores,
  usage: Pick<Eval, 'codex' | 'claude5h'>,
  incumbent?: Scores,
  runs = 3
): Eval => {
  const qs = cases.map(c => getMean(mine.get(c)?.qs ?? []));
  const per = (s: Scores, k: 'paid' | 'took') => cases.map(c => getMean(s.get(c)?.[k] ?? []));
  const both = cases.filter(c => mine.get(c)?.paid.length && incumbent?.get(c)?.paid.length);
  const saving = (k: 'paid' | 'took') => {
    const s = both.map(c => getRounded(1 - getMean(mine.get(c)![k]) / Math.max(1e-9, getMean(incumbent!.get(c)![k]))));
    const p = paired(
      s.map(() => 0),
      s
    );
    return { share: p.delta, pDown: p.pUp };
  };
  const p = incumbent && {
    ...paired(
      cases.map(c => getMean(incumbent.get(c)?.qs ?? [])),
      qs
    ),
    flips: flipsOf(qsOf(incumbent, cases), qsOf(mine, cases), runs),
  };
  return {
    variant,
    split,
    cases,
    quality: getRounded(getMean(qs)),
    ci: paired(
      qs.map(() => 0),
      qs
    ).ci,
    ...(p && { delta: p.delta, pUp: p.pUp, flips: p.flips }),
    usd: getRounded(sum(cases.map(c => mine.get(c)?.usd ?? 0))),
    minutes: getRounded(sum(cases.map(c => mine.get(c)?.min ?? 0))),
    perRun: {
      usd: getRounded(getMean(per(mine, 'paid').filter(Boolean))),
      minutes: getRounded(getMean(per(mine, 'took').filter(Boolean))),
    },
    ...(incumbent &&
      both.length && {
        saved: { usd: saving('paid'), minutes: saving('took') },
      }),
    ...usage,
  };
};

type Job = { id: string; iteration: number; case: string; repeat?: number };
export const makeJobInput = (dir: string, t: Tune, j: Pick<Job, 'id' | 'case' | 'repeat'>) =>
  makeBenchInput(readBenchCase(join(dir, 'cases', j.case)), 'v2', j.repeat ?? 1, {
    point: t.point,
    graph: join(dir, 'cands', j.id, 'graph'),
    labels: { variant: j.id },
  });
const tuneLog = (dir: string) => (e: object) =>
  appendJsonl(join(dir, 'log.jsonl'), { at: new Date().toISOString(), ...e });

/** Labels every attempt of a job's slot with the tune and the variant's iteration. */
const labelJobRuns = async (dir: string, t: Tune, j: Job) => {
  const labels = { tune: getTuneLabel(dir), iteration: String(j.iteration) };
  for (const a of readBenchSlots(dir).get(getBenchSlot(makeJobInput(dir, t, j))) ?? [])
    if (a.run) await Effect.runPromise(writeRunLabels(a.data, a.run.id, labels));
};

/**
 * The bench as the tune drives it: one v2 run and score per job through bin/bench.ts, judged on request, `parallel` at
 * a time. The tune dir is the bench set; each variant's runs carry its `variant` label.
 */
const bench = {
  run: async (dir: string, t: Tune, jobs: Job[], o: { parallel: number; judged?: boolean; keys?: string }) => {
    engineAt(t);
    mkdirSync(join(dir, 'logs'), { recursive: true });
    const env = { ...process.env, NODE_OPTIONS: '' };
    const call = (command: string, j: Job) =>
      runLogged(
        [
          join(agentgraphDir, 'bin/bench.ts'),
          command,
          'v2',
          join(dir, 'cases', j.case),
          dir,
          '--repo',
          t.clone,
          '--graph',
          join(dir, 'cands', j.id, 'graph'),
          '--point',
          t.point,
          '--repeat',
          String(j.repeat ?? 1),
          '--label',
          `variant=${j.id}`,
          ...(o.keys ? ['--keys', o.keys] : []),
        ],
        join(dir, 'logs', `${j.id}-${j.case}-r${j.repeat ?? 1}.log`),
        env
      );
    const evaluate = async (j: Job) => {
      await call('score', j);
      if (isBenchCaseValid(dir, j.case) !== false) {
        await call('run', j);
        await call('score', j);
        if (o.judged) await call('judge', j);
      }
      await labelJobRuns(dir, t, j);
    };
    const finished = (j: Job) => isBenchRunDone(dir, makeJobInput(dir, t, j), Boolean(o.judged));
    const log = tuneLog(dir);
    for (let round = 0, left = jobs; ;) {
      await runQueue([...left], o.parallel, evaluate);
      left = jobs.filter(j => !finished(j));
      if (!left.length) return;
      const held = left.some(j => isLockedByOtherProcess(findSlotLock(dir, makeJobInput(dir, t, j))));
      log({ event: 'unfinished', jobs: left.length, held, round });
      if (!held && ++round >= 3) throw new Error(`${left.length} runs unfinished after 3 rounds; rerun to resume`);
      await waitWhileServicesDown(log);
      await sleep(held ? 30_000 : 60_000);
    }
  },
  /** Rows of every run of a variant, its repeats included. */
  rows: readVariantRows,
  codex: () => codexUsed(),
  propose: (o: Parameters<typeof proposeWith>[0]) => proposeWith(o),
};
type Io = typeof bench;

/** The engine dir to run, after checking its `src` tree is the pinned engine's. */
const engineAt = (t: Tune) => {
  const dir = agentgraphDir;
  const tree = (rev: string) => {
    const result = spawnSync('git', ['-C', dir, 'rev-parse', `${rev}:./src`], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`engine tree ${rev}: ${result.error?.message ?? result.stderr}`);
    return result.stdout.trim();
  };
  if (tree('HEAD') !== tree(t.engine)) throw new Error(`the engine at ${dir} is not the tune's ${t.engine}`);
  return dir;
};

const git = (dir: string, args: string[], o: { graph?: string; index?: string } = {}) =>
  execFileSync('git', ['--git-dir', join(dir, 'graph.git'), ...(o.graph ? ['--work-tree', o.graph] : []), ...args], {
    encoding: 'utf8',
    cwd: o.graph ?? dir,
    env: {
      ...process.env,
      ...(o.index && { GIT_INDEX_FILE: o.index }),
      GIT_AUTHOR_NAME: 'tune',
      GIT_AUTHOR_EMAIL: 'tune@agentgraph.invalid',
      GIT_COMMITTER_NAME: 'tune',
      GIT_COMMITTER_EMAIL: 'tune@agentgraph.invalid',
    },
  }).trim();

export const readVariantDiff = (dir: string, v: Pick<Variant, 'base' | 'graph'>) =>
  v.base ? git(dir, ['diff', v.base, v.graph]) : '';

/**
 * Commits `cands/<id>/graph` on the parent's graph as `refs/variant/<id>` and starts the variant's control run, which
 * keeps it pending until its decision.
 */
const enqueue = async (
  dir: string,
  c: Pick<Variant, 'id' | 'iteration' | 'proposer' | 'rationale'>,
  parent?: Pick<Variant, 'id' | 'graph'>
) => {
  const graph = join(dir, 'cands', c.id, 'graph');
  const index = join(dir, 'graph.git', `index.${c.id}`);
  git(dir, ['add', '-A', '.'], { graph, index });
  const tree = git(dir, ['write-tree'], { graph, index });
  rmSync(index, { force: true });
  const sha = git(dir, ['commit-tree', tree, ...(parent ? ['-p', parent.graph] : []), '-m', c.id]);
  git(dir, ['update-ref', `refs/variant/${c.id}`, sha]);
  const v: Variant = { ...c, parent: parent?.id ?? '', base: parent?.graph ?? '', graph: sha };
  await writeVariantRun(dir, tuneRows(dir).tune.engine, v, readVariantDiff(dir, v));
  return v;
};

const incumbentOf = (steps: TuneStep[]) => steps.filter(s => s.verdict === 'kept').at(-1);
const nextIteration = (steps: TuneStep[]) => Math.max(0, ...steps.map(s => s.iteration)) + 1;
const freeId = (dir: string, iteration: number, proposer: string) => {
  const base = `i${pad(iteration)}-${proposer}`;
  for (let n = 1; ; n++)
    if (!existsSync(join(dir, 'cands', n === 1 ? base : `${base}-${n}`))) return n === 1 ? base : `${base}-${n}`;
};

/** Queues a graph dir as a variant on the incumbent; the next step evaluates it. */
export const propose = async (dir: string, from: string, why: string, proposer: Proposer = 'manual') => {
  const { steps } = tuneRows(dir);
  const parent = incumbentOf(steps);
  if (!parent) throw new Error(`no incumbent in ${dir} yet: run init first`);
  const id = freeId(dir, nextIteration(steps), proposer);
  cpSync(resolve(from), join(dir, 'cands', id, 'graph'), { recursive: true });
  return enqueue(dir, { id, iteration: nextIteration(steps), proposer, rationale: why }, parent);
};

/** Variants started but not decided yet, after turning each `manual/*.patch` into one. */
const pending = async (dir: string, steps: TuneStep[]) => {
  const parent = incumbentOf(steps)!;
  const patches = existsSync(join(dir, 'manual'))
    ? readdirSync(join(dir, 'manual')).filter(n => n.endsWith('.patch'))
    : [];
  for (const name of patches) {
    const patch = join(dir, 'manual', name);
    const graph = join(dir, 'cands', freeId(dir, nextIteration(steps), 'manual'), 'graph');
    cpSync(join(dir, 'cands', parent.id, 'graph'), graph, { recursive: true });
    execFileSync('git', ['apply', patch], {
      cwd: graph,
      env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(graph) },
    });
    const rationale = readFileOrEmpty(patch)
      .split(/\n\s*\n/)[0]!
      .trim();
    await enqueue(
      dir,
      { id: basename(dirname(graph)), iteration: nextIteration(steps), proposer: 'manual', rationale },
      parent
    );
    mkdirSync(join(dir, 'manual', 'applied'), { recursive: true });
    renameSync(patch, join(dir, 'manual', 'applied', name));
  }
  return readTuneSteps(dir).pending;
};

/** `r` after reading `now`: a drop means the window reset, so everything read since counts as used. */
export const reading = (r: Reading | undefined, now: number): Reading => ({
  now,
  used: getRounded((r?.used ?? 0) + (!r ? 0 : now >= r.now ? now - r.now : now)),
});

/** The first cap the budget is past, in words. */
export const overOf = (b: Budget, limits: Limits) =>
  (
    [
      ['Codex weekly', b.codex, limits.codex],
      ['Claude 5h', b.claude?.fiveHour, limits.claude5h],
      ['Claude weekly', b.claude?.week, limits.claudeWeek],
    ] as const
  ).flatMap(([name, r, max]) => (r && r.used > max ? [`${name} used ${r.used} points, more than ${max}`] : []))[0];

/** Reads the guards, records them, and throws past a cap. */
export const guard = (
  dir: string,
  io: Pick<Io, 'codex'>,
  limits: Limits,
  claude?: { fiveHour: number; week: number }
) => {
  const file = join(dir, 'budget.json');
  const b = JSON.parse(readFileOrEmpty(file) || '{}') as Budget;
  const mark = (r: Reading | undefined, now: number | undefined) => (now === undefined ? r : reading(r, now));
  const now = io.codex();
  if (now === undefined || !Number.isFinite(now)) throw new Error('Codex usage unreadable; tuning stopped');
  const codex = mark(b.codex, now);
  const fiveHour = mark(b.claude?.fiveHour, claude?.fiveHour);
  const week = mark(b.claude?.week, claude?.week);
  const next: Budget = { ...(codex && { codex }), claude: { ...(fiveHour && { fiveHour }), ...(week && { week }) } };
  writeFileAtomic(file, next);
  const over = overOf(next, limits);
  if (over) throw new Error(over);
  return next;
};
type Limits = { codex: number; claude5h: number; claudeWeek: number };
const limitsDefault: Limits = { codex: 25, claude5h: 40, claudeWeek: 12 };

const spent = (before: Budget, after: Budget, k: 'codex' | 'fiveHour') => {
  const of = (b: Budget) => (k === 'codex' ? b.codex : b.claude?.fiveHour)?.used ?? 0;
  return getRounded(of(after) - of(before));
};

/** Writes tune.json, the cases and the minimal graph, then evaluates that graph as the first incumbent. */
export const init = async (
  repo: string,
  o: {
    cases: string;
    splits: string;
    repos: string;
    point: string;
    name?: string;
    parallel?: number;
    keys?: string;
    limits?: Limits;
  },
  io: Io = bench
) => {
  const short = repo.split('/').pop()!;
  const dir = join(tuneRoot(), short, o.name ?? 't1');
  if (!existsSync(join(dir, 'tune.json'))) {
    const splits = JSON.parse(readFileOrEmpty(o.splits)) as Record<string, string>;
    const meta = (id: string) =>
      JSON.parse(readFileOrEmpty(join(o.cases, id, 'case.json')) || '{}') as Record<string, unknown>;
    const gated = Object.keys(splits).filter(id => {
      const m = meta(id);
      return (
        String(m.repo ?? '')
          .split('/')
          .pop() === short && m.bucket !== 'no-tests'
      );
    });
    const train = gated.filter(id => ['train', 'mine', 'fit'].includes(splits[id]!));
    train.sort((a, b) => String(meta(a).mergedAt).localeCompare(String(meta(b).mergedAt)));
    const cases: Record<string, Split> = {};
    for (const [i, id] of train.entries()) cases[id] = i < Math.floor(train.length / 2) ? 'mine' : 'fit';
    for (const id of gated) if (splits[id] === 'validate' || splits[id] === 'test') cases[id] = splits[id];
    for (const id of Object.keys(cases)) cpSync(join(o.cases, id), join(dir, 'cases', id), { recursive: true });
    const engine = (...args: string[]) =>
      spawnSync('git', ['-C', agentgraphDir, ...args], { encoding: 'utf8' }).stdout.trim();
    const t: Tune = {
      repo: String(meta(gated[0] ?? '').repo ?? repo),
      engine:
        engine('describe', '--tags', '--exact-match', '--match', 'agentgraph-v*', 'HEAD') ||
        engine('rev-parse', 'HEAD'),
      point: o.point,
      cases,
      preset: 'hidden',
      keep: { runs: 3, drops: 2 },
      clone: resolve(o.repos, short),
    };
    const first = meta(train[0] ?? gated[0] ?? '');
    minimal(
      join(dir, 'cands', 'i000-init', 'graph'),
      pickBenchTestCommands(
        t.repo,
        Array.isArray(first.tests) ? (first.tests as string[]) : [],
        Object.fromEntries(
          ['test', 'suite', 'setup', 'typecheck', 'runner'].flatMap(k =>
            typeof first[k] === 'string' ? [[k, first[k]]] : []
          )
        )
      ),
      readFileOrEmpty(join(agentgraphDir, 'examples', short, 'settings.yaml')).match(/^toolchain: .*$/m)?.[0]
    );
    execFileSync('git', ['init', '-q', '--bare', join(dir, 'graph.git')]);
    writeFileAtomic(join(dir, 'tune.json'), t);
  }
  const { tune: t, steps, pending: started } = tuneRows(dir);
  if (steps.length) return dir;
  const cand =
    started.find(v => v.id === 'i000-init') ??
    (await enqueue(dir, { id: 'i000-init', iteration: 0, proposer: 'manual', rationale: 'The minimal graph.' }));
  git(dir, ['update-ref', 'refs/heads/main', cand.graph]);
  const select = ids(t, 'fit', 'validate');
  if (!select.length) throw new Error('no fit or validate cases to score');
  const before = guard(dir, io, o.limits ?? limitsDefault);
  await io.run(
    dir,
    t,
    select.map(c => ({ id: cand.id, iteration: 0, case: c })),
    { parallel: o.parallel ?? 6, ...(o.keys && { keys: o.keys }) }
  );
  const after = guard(dir, io, o.limits ?? limitsDefault);
  const mine = scores(io.rows(dir, cand.id), t.preset);
  const missing = findUnscoredCases(select, mine);
  if (missing.length) throw new Error(`${missing.length} initial cases lack scored runs: ${missing.join(', ')}`);
  const usage = { codex: spent(before, after, 'codex'), claude5h: 0 };
  const evals = (['fit', 'validate'] as const)
    .filter(s => ids(t, s).length)
    .map((s, i) => evalOf(cand.id, s, ids(t, s), mine, i ? { codex: 0, claude5h: 0 } : usage));
  await writeVariantDecision(dir, t.engine, {
    ...cand,
    evals,
    verdict: 'kept',
    why: 'the starting graph',
    at: new Date().toISOString(),
  });
  return dir;
};

/**
 * The bench graph with no reviewer and no end checks: implement with two tries against a tests check, then a human merge. A repo with a
 * toolchain line builds through the toolchain step, so the case plan's host setup is left out.
 */
const minimal = (graph: string, commands: ReturnType<typeof pickBenchTestCommands>, toolchain?: string) => {
  cpSync(join(agentgraphDir, 'examples/bench'), graph, { recursive: true });
  rmSync(join(graph, 'agents/reviewer.md'), { force: true });
  rmSync(join(graph, 'scripts/review.mjs'), { force: true });
  for (const check of ['run-stats', 'tests-share']) rmSync(join(graph, `checks/${check}.md`), { force: true });
  writeFileAtomic(
    join(graph, 'workflows/issue.md'),
    `---
on: issue_comment
branch: agentgraph/{issue}
steps:
  implement:
    agent: implementor
    tries: 2
    checks: [tests]
  merge: { wait: human, back: implement }
---
One issue becomes one pull request. The implementor changes the repo until the tests check passes. A human merges.
`
  );
  writeFileAtomic(
    join(graph, 'checks/tests.md'),
    readFileOrEmpty(join(graph, 'checks/tests.md')).replace('npm test', 'sh "$AGENTGRAPH_DIR/scripts/tests.sh"')
  );
  const each = commands.runner
    ? `${commands.runner} $files`
    : `for f in $files; do
  d=$(dirname "$f")
  while [ "$d" != . ] && [ ! -f "$d/package.json" ]; do d=$(dirname "$d"); done
  if grep -q '"jest"' "$d/package.json"; then (cd "$d" && npx jest --runTestsByPath "\${f#"$d"/}") || exit 1
  elif grep -q '"vitest"' "$d/package.json"; then (cd "$d" && npx vitest run "\${f#"$d"/}") || exit 1
  else echo "unknown test runner in $d/package.json" >&2; exit 1; fi
done`;
  writeFileAtomic(
    join(graph, 'scripts/tests.sh'),
    `set -f\nfiles=$(git ls-files -mo --exclude-standard | grep -E '[.](test|spec)[.][jt]sx?$')\n[ -n "$files" ] || { echo "tests skipped: no changed test files" >&2; exit 1; }\n${each}\n`
  );
  if (toolchain)
    writeFileAtomic(join(graph, 'settings.yaml'), `${toolchain}\n${readFileOrEmpty(join(graph, 'settings.yaml'))}`);
  else if (commands.setup)
    writeFileAtomic(
      join(graph, 'settings.yaml'),
      `setup: ${JSON.stringify(commands.setup)}\n${readFileOrEmpty(join(graph, 'settings.yaml'))}`
    );
};

/** One iteration: proposals, a screen on a few fit cases, the survivors on the rest of select, at most one kept. */
export const step = async (
  dir: string,
  o: {
    k?: number;
    proposers?: Proposer[];
    parallel?: number;
    limits?: Limits;
    keys?: string;
    claude?: Record<string, number>;
    model?: string;
  } = {},
  io: Io = bench
) => {
  const { tune: t, steps } = tuneRows(dir);
  const inc = incumbentOf(steps);
  if (!inc) throw new Error(`no incumbent in ${dir}: run init`);
  const limits = o.limits ?? limitsDefault;
  const iteration = nextIteration(steps);
  const claude: Record<string, number> = { ...o.claude };
  const queued = await pending(dir, steps);
  const auto = ['retro', 'history', 'structure'] as const;
  const failed: string[] = [];
  for (const proposer of auto.filter(p => (o.proposers ?? ['retro', 'history']).includes(p))) {
    if (queued.length >= (o.k ?? 3)) break;
    const id = freeId(dir, iteration, proposer);
    const before = guard(dir, io, limits);
    const made = await io
      .propose({
        tune: dir,
        id,
        proposer,
        from: join(dir, 'cands', inc.id, 'graph'),
        variant: inc.id,
        iteration,
        ...(o.model && { model: o.model }),
      })
      .catch((e: unknown) => void failed.push(`${id}: ${String(e)}`));
    if (!made?.graph) {
      if (made?.problems?.length) failed.push(`${id}: ${made.problems.join('; ')}`);
      continue;
    }
    const after = guard(dir, io, limits, made.usage);
    claude[id] = spent(before, after, 'fiveHour');
    queued.push(await enqueue(dir, { id, iteration, proposer, rationale: made.rationale }, inc));
  }
  for (const f of failed) {
    console.error(f);
    tuneLog(dir)({ event: 'proposer-failed', why: f });
  }
  if (!queued.length && failed.length) throw new Error(`every proposer failed; rerun to resume\n${failed.join('\n')}`);
  if (!queued.length) return [];
  const { runs } = keepOf(t);
  const theirs = () => scores(io.rows(dir, inc.id), t.preset);
  const fit = ids(t, 'fit');
  const offset = ((iteration - 1) * 4) % Math.max(1, fit.length);
  const screened = [...fit.slice(offset), ...fit.slice(0, offset)].slice(0, 4);
  const rest = ids(t, 'fit', 'validate').filter(c => !screened.includes(c));
  const select = [...screened, ...rest];
  const phase = async (jobs: Job[], per: number) => {
    if (!jobs.length) return 0;
    const before = guard(dir, io, limits);
    await io.run(dir, t, jobs, { parallel: o.parallel ?? 6, ...(o.keys && { keys: o.keys }) });
    return getRounded(spent(before, guard(dir, io, limits), 'codex') / Math.max(1, per));
  };
  const cross = (vs: Variant[], cases: string[]) =>
    vs.flatMap(v => cases.map(k => ({ id: v.id, iteration: v.iteration, case: k })));
  const usage = (v: Variant, codex: number) => ({ codex, claude5h: claude[v.id] ?? 0 });
  const screenCodex = await phase(cross(queued, screened), queued.length);
  const before = theirs();
  const results = queued.map(c => {
    const mine = scores(io.rows(dir, c.id), t.preset);
    const screen = evalOf(c.id, 'fit', screened, mine, usage(c, screenCodex), before, runs);
    const missing = findUnscoredCases(screened, mine, before);
    return { c, screen, evals: [screen], missing, verdict: missing.length ? ('infra' as const) : decide(t, screen) };
  });
  const survivors = results.filter(r => r.verdict === 'discarded');
  const fullCodex = await phase(
    cross(
      survivors.map(r => r.c),
      rest
    ),
    survivors.length
  );
  const repeats = (v: Pick<Variant, 'id' | 'iteration'>, s: Scores, cases: string[]) =>
    cases.flatMap(k => {
      const { qs = [], runs: n = 0 } = s.get(k) ?? {};
      return Array.from({ length: Math.max(0, runs - qs.length) }, (_, i) => ({
        id: v.id,
        iteration: v.iteration,
        case: k,
        repeat: n + i + 1,
      }));
    });
  const now = theirs();
  const flipped = survivors.flatMap(r => {
    const mine = scores(io.rows(dir, r.c.id), t.preset);
    const f = flipsOf(qsOf(now, select), qsOf(mine, select), runs);
    const open = Object.keys(f).filter(k => f[k] === 'up' || f[k] === 'down');
    return Object.values(f).includes('up') && open.length ? [{ v: r.c, mine, open }] : [];
  });
  const shared = [...new Set(flipped.flatMap(f => f.open))];
  const confirmCodex = await phase(
    [...repeats(inc, now, shared), ...flipped.flatMap(f => repeats(f.v, f.mine, f.open))],
    flipped.length
  );
  const after = theirs();
  const full = survivors.map(r => {
    const mine = scores(io.rows(dir, r.c.id), t.preset);
    const codex = fullCodex + (flipped.some(f => f.v.id === r.c.id) ? confirmCodex : 0);
    const parts = (['fit', 'validate'] as const)
      .map(s => [s, rest.filter(k => t.cases[k] === s)] as const)
      .filter(([, cases]) => cases.length);
    const splits = parts.map(([s, cases]) =>
      evalOf(r.c.id, s, cases, mine, { codex: getRounded(codex / parts.length), claude5h: 0 }, after, runs)
    );
    const all = evalOf(r.c.id, 'fit', select, mine, usage(r.c, 0), after, runs);
    const screen = evalOf(r.c.id, 'fit', screened, mine, usage(r.c, screenCodex), after, runs);
    const missing = findUnscoredCases(select, mine, after);
    return {
      ...r,
      evals: [screen, ...splits],
      all,
      missing,
      verdict: missing.length ? ('infra' as const) : decide(t, r.screen, all),
    };
  });
  const net = (e: Eval) => count(e, 'win') - count(e, 'loss');
  const best = full
    .filter(r => r.verdict === 'kept')
    .sort(
      (a, b) =>
        net(b.all) - net(a.all) ||
        (b.all.delta ?? 0) - (a.all.delta ?? 0) ||
        (b.all.saved?.usd.share ?? 0) - (a.all.saved?.usd.share ?? 0)
    )[0];
  const why = (r: (typeof results)[number] & { all?: Eval }) => {
    const named = (e: Eval, ...of: Flip[]) =>
      Object.keys(e.flips ?? {})
        .filter(k => of.includes(e.flips![k]!))
        .join(', ') || 'none';
    const cost = ({ saved: s }: Eval) =>
      s
        ? `, usd ${getRounded(-s.usd.share)} and minutes ${getRounded(-s.minutes.share)} per run (P ${s.usd.pDown}, ${s.minutes.pDown})`
        : '';
    const on = (e: Eval) =>
      `won ${named(e, 'win')}, lost ${named(e, 'loss')}, delta ${e.delta} over ${e.cases.length} cases${cost(e)}`;
    if (r.verdict === 'infra') return `${r.missing.length} cases lack scored runs: ${r.missing.join(', ')}`;
    if (r.verdict === 'screened-out') return `screen dropped ${named(r.screen, 'down', 'loss')}`;
    if (!r.all) return 'no select cases beyond the screen';
    if (r === best) return `select ${on(r.all)}`;
    return r.verdict === 'kept' ? `select ${on(r.all)}, beaten by ${best!.c.id}` : `select ${on(r.all)}, below the bar`;
  };
  const out: TuneStep[] = [...results.filter(r => r.verdict !== 'discarded'), ...full].map(r => ({
    ...r.c,
    evals: r.evals,
    verdict: r === best ? 'kept' : r.verdict === 'kept' ? 'discarded' : r.verdict,
    why: why(r),
    at: new Date().toISOString(),
  }));
  for (const s of out) await writeVariantDecision(dir, t.engine, s);
  if (best) git(dir, ['update-ref', 'refs/heads/main', best.c.graph]);
  return out;
};

/** The incumbent on the test split with the judge panel, added to its step. */
export const checkpoint = async (dir: string, o: { parallel?: number; keys?: string } = {}, io: Io = bench) => {
  const { tune: t, steps } = tuneRows(dir);
  const inc = incumbentOf(steps)!;
  const test = ids(t, 'test');
  await io.run(
    dir,
    t,
    test.map(c => ({ id: inc.id, iteration: inc.iteration, case: c })),
    { parallel: o.parallel ?? 6, judged: true, ...(o.keys && { keys: o.keys }) }
  );
  const mine = scores(io.rows(dir, inc.id), 'composite');
  const missing = findUnscoredCases(test, mine);
  if (missing.length) throw new Error(`${missing.length} test cases lack scored runs: ${missing.join(', ')}`);
  const e = evalOf(inc.id, 'test', test, mine, { codex: 0, claude5h: 0 });
  await writeVariantTest(dir, t.engine, inc.id, e);
  return e;
};

/** Iterations at the end of the tune in a row that kept nothing. */
const flatOf = (steps: TuneStep[]) => {
  const kept = new Set(steps.filter(s => s.verdict === 'kept').map(s => s.iteration));
  const last = nextIteration(steps) - 1;
  let n = 0;
  while (last - n > 0 && !kept.has(last - n)) n++;
  return n;
};

/** Whether the incumbent is every third keep and has no test eval yet. */
const due = (steps: TuneStep[]) => {
  const kept = steps.filter(s => s.verdict === 'kept');
  return kept.length > 1 && kept.length % 3 === 1 && !kept.at(-1)!.evals.some(e => e.split === 'test');
};

/**
 * Steps until `iterations` more, the tune reaches iteration `until`, three iterations in a row keep nothing, a step has
 * no candidate or only infra verdicts, or a guard stops it; checkpoints every third keep. All of it reads from disk, so a rerun resumes.
 */
export const run = async (
  dir: string,
  o: Parameters<typeof step>[1] & { iterations: number; until?: number },
  io: Io = bench
) => {
  for (let i = 0; i < o.iterations; i++) {
    if (due(tuneRows(dir).steps)) await checkpoint(dir, o, io);
    const { steps } = tuneRows(dir);
    if (flatOf(steps) >= 3 || nextIteration(steps) > (o.until ?? Infinity)) break;
    const made = await step(dir, o, io);
    if (!made.length) break;
    if (made.every(s => s.verdict === 'infra')) {
      console.error(`every candidate of step ${made[0]!.iteration} was infra: fix the bench before the next step`);
      break;
    }
  }
  if (due(tuneRows(dir).steps)) await checkpoint(dir, o, io);
};

/**
 * One screen on a tune: the incumbent's scores, its last steps, the budget used against `limits`, whether a process
 * runs it, and the variants under evaluation.
 * @internal
 */
export const status = (dir: string, limits = limitsDefault) => {
  const { tune: t, steps, pending: open } = tuneRows(dir);
  const inc = incumbentOf(steps);
  const q = (es: Eval[]) => {
    const n = sum(es.map(e => e.cases.length));
    return n ? `${getRounded(sum(es.map(e => e.quality * e.cases.length)) / n)} on ${n}` : '-';
  };
  const on = (...splits: Split[]) => q(inc?.evals.filter(e => splits.includes(e.split)) ?? []);
  const b = JSON.parse(readFileOrEmpty(join(dir, 'budget.json')) || '{}') as Budget;
  const used = (name: string, r: Reading | undefined, max: number) => `${name} ${r?.used ?? '-'} of ${max}`;
  const live = Boolean(readFileOrEmpty(join(dir, 'tune.lock'))) && isLockedByOtherProcess(join(dir, 'tune'));
  const pid = Number(readFileOrEmpty(join(dir, 'tune.lock')) || 0);
  const last = readJsonl(join(dir, 'log.jsonl')).at(-1);
  const written = statSync(join(dir, 'log.jsonl'), { throwIfNoEntry: false })?.mtimeMs ?? 0;
  return [
    `${t.repo} on ${t.point}: ${steps.length} steps over ${nextIteration(steps) - 1} iterations, incumbent ${inc?.id ?? 'none yet'}`,
    `  quality, human = 1: select ${on('fit', 'validate')}, validate ${on('validate')}, test ${on('test')}`,
    `  points used: ${used('Codex', b.codex, limits.codex)}, ${used('Claude 5h', b.claude?.fiveHour, limits.claude5h)}, ${used('Claude week', b.claude?.week, limits.claudeWeek)}`,
    `  bench runs: $${getRounded(sum(steps.flatMap(s => s.evals.map(e => e.usd))))}, ${Math.round(sum(steps.flatMap(s => s.evals.map(e => e.minutes))))} min`,
    ...steps.slice(-5).map(s => `  ${s.id} ${s.verdict}: ${s.why}`),
    live ? `running as pid ${pid}` : 'no live lock',
    written ? `last log write ${Math.round((Date.now() - written) / 60_000)} min ago` : 'no log yet',
    ...(last ? [`last event: ${JSON.stringify(last)}`] : []),
    ...(open.length ? [`evaluating ${open.map(v => v.id).join(', ')}`] : []),
  ].join('\n');
};

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      cases: { type: 'string' },
      splits: { type: 'string' },
      repos: { type: 'string' },
      point: { type: 'string', default: 'opencode:luna' },
      name: { type: 'string' },
      k: { type: 'string', default: '3' },
      proposers: { type: 'string', default: 'retro,history,manual' },
      parallel: { type: 'string', default: '6' },
      iterations: { type: 'string', default: '8' },
      until: { type: 'string' },
      'max-codex': { type: 'string', default: '25' },
      'max-claude-5h': { type: 'string', default: '40' },
      'max-claude-week': { type: 'string', default: '12' },
      from: { type: 'string' },
      why: { type: 'string' },
      as: { type: 'string', default: 'manual' },
      keys: { type: 'string' },
      'proposer-model': { type: 'string' },
    },
  });
  const [command, target] = positionals;
  const o = {
    k: Number(values.k),
    proposers: values.proposers.split(',') as Proposer[],
    parallel: Number(values.parallel),
    limits: {
      codex: Number(values['max-codex']),
      claude5h: Number(values['max-claude-5h']),
      claudeWeek: Number(values['max-claude-week']),
    },
    ...(values.keys && { keys: resolve(values.keys) }),
    ...(values['proposer-model'] && { model: values['proposer-model'] }),
  };
  const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));
  const dir =
    target && resolve(command === 'init' ? join(tuneRoot(), target.split('/').pop()!, values.name ?? 't1') : target);
  if (command === 'status' && dir) {
    const under = (d: string, depth: number): string[] =>
      existsSync(join(d, 'tune.json')) ? [d] : depth ? subdirs(d).flatMap(n => under(join(d, n), depth - 1)) : [];
    const tunes = under(dir, 2);
    if (!tunes.length) console.error(`no tune.json in ${dir} or two folders under it`);
    console.log(tunes.map(d => `${d}\n${status(d, o.limits)}`).join('\n\n'));
    process.exit(tunes.length ? 0 : 1);
  }
  if (dir && ['init', 'step', 'run', 'checkpoint'].includes(command ?? '')) {
    if (!claim(join(dir, 'tune'))) {
      console.error(`another process runs ${dir}: ${readFileOrEmpty(join(dir, 'tune.lock'))}`);
      process.exit(1);
    }
    process.on('exit', () => release(join(dir, 'tune')));
    onStop(signal => {
      tuneLog(dir)({ event: 'paused', signal });
      release(join(dir, 'tune'));
    });
  }
  if (command === 'init' && target && values.cases && values.splits && values.repos)
    console.log(
      await init(target, {
        ...o,
        cases: values.cases,
        splits: values.splits,
        repos: values.repos,
        point: values.point,
        ...(values.name && { name: values.name }),
      })
    );
  else if (command === 'step' && target) print((await step(resolve(target), o)).map(s => [s.id, s.verdict, s.why]));
  else if (command === 'run' && target)
    await run(resolve(target), {
      ...o,
      iterations: Number(values.iterations),
      ...(values.until && { until: Number(values.until) }),
    });
  else if (command === 'checkpoint' && target) print(await checkpoint(resolve(target), o));
  else if (command === 'propose' && target && values.from && values.why)
    console.log((await propose(resolve(target), values.from, values.why, values.as as Proposer)).id);
  else {
    console.error(
      'usage: node bin/tune.ts (init <repo> --cases --splits --repos --point | step | run [--until n] | checkpoint | status | propose --from --why) <tune dir>'
    );
    process.exit(2);
  }
}
