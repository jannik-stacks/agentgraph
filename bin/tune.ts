/**
 * Hill-climbs a hub on one repo's replayed pull requests: each step evaluates candidate hubs with the bench and keeps
 * one only when it beats the incumbent on the select cases (fit plus validate).
 * Usage: node bin/tune.ts init <repo> --cases <dir> --splits <file> --repos <dir> --point opencode:luna [--name t1]
 *        node bin/tune.ts step <tune dir> [--k 3] [--proposers retro,history,manual] [--parallel 6]
 *        node bin/tune.ts run <tune dir> --iterations 8 [--max-codex 25] [--max-claude-5h 40] [--max-claude-week 12]
 *        node bin/tune.ts checkpoint <tune dir>
 *        node bin/tune.ts propose <tune dir> --from <hub dir> --why <text> [--as manual|skill]
 *        node bin/tune.ts status <tune dir or root> [--max-codex 25] [--max-claude-5h 40] [--max-claude-week 12]
 * Tunes live in <root>/<repo>/<name>; the root is AGENTGRAPH_TUNE, by default ~/.agentgraph/tune.
 */
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { presets, quality, random } from '../studio/src/bench/score.ts';
import { propose as proposeWith } from '../tune/propose.ts';
import { codexUsed, pickBenchTestCommands, progress, readBenchRows, statusText } from './bench.ts';
import {
  appendJsonl,
  readBenchResultEnv,
  busy,
  claim,
  readJsonl,
  onStop,
  ensureRunSettingsPinned,
  release,
  waitWhileServicesDown,
  writeFileAtomic,
} from './resume.ts';

export type Split = 'mine' | 'fit' | 'validate' | 'test';
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
/** A case where the candidate scores half a point off an incumbent whose runs agree; a win or loss once it held. */
export type Flip = 'up' | 'down' | 'win' | 'loss';
type Proposer = 'retro' | 'history' | 'manual' | 'skill' | 'structure';
type Candidate = {
  id: string;
  iteration: number;
  parent: string;
  proposer: Proposer;
  hub: string;
  rationale: string;
  diff: string;
};
type Eval = {
  candidate: string;
  split: Split;
  cases: string[];
  quality: number;
  ci: [number, number];
  delta?: number;
  pUp?: number;
  flips?: Record<string, Flip>;
  usd: number;
  minutes: number;
  /** Mean usd and minutes of one run that was not infra, averaged over the cases. */
  perRun?: { usd: number; minutes: number };
  /** Against the incumbent: the mean share saved per case and the share of bootstrap draws that saved anything. */
  saved?: Record<'usd' | 'minutes', { share: number; pDown: number }>;
  codex: number;
  claude5h: number;
};
export type Step = Candidate & {
  evals: Eval[];
  verdict: 'kept' | 'discarded' | 'screened-out' | 'infra';
  why: string;
  at: string;
};
type Row = ReturnType<typeof readBenchRows>[number];
/** The latest reading of a usage window in percent, and the points used since the first, across window resets. */
type Reading = { now: number; used: number };
type Budget = { codex?: Reading; claude?: { fiveHour?: Reading; week?: Reading } };

const agentgraph = join(import.meta.dirname, '..');
const tuneRoot = () => process.env.AGENTGRAPH_TUNE ?? join(homedir(), '.agentgraph/tune');
const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
const round = (n: number) => Math.round(n * 1000) / 1000;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : 0);
const sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0);
const pad = (n: number) => String(n).padStart(3, '0');

/** The tune's settings and its steps in order, as `iterations.jsonl` holds them. */
export const tuneRows = (dir: string) => {
  const tune = read(join(dir, 'tune.json'));
  if (!tune) throw new Error(`${dir} has no tune.json`);
  return { tune: JSON.parse(tune) as Tune, steps: readJsonl<Step>(join(dir, 'iterations.jsonl')) };
};

const subdirs = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap(e =>
        e.isDirectory() && !e.name.startsWith('.') ? [e.name] : []
      )
    : [];

/** Every tune under `root`, each with its folder name. */
export const tunesOf = (root = tuneRoot()) =>
  subdirs(root).flatMap(repo =>
    subdirs(join(root, repo))
      .filter(name => existsSync(join(root, repo, name, 'tune.json')))
      .map(name => ({ name, ...tuneRows(join(root, repo, name)) }))
  );

/** The mean gain of `b` over `a` case by case, the share of bootstrap draws above 0 and its 95% interval. */
export const paired = (a: number[], b: number[], n = 2000) => {
  const d = b.map((x, i) => x - (a[i] ?? 0));
  if (!d.length) return { delta: 0, pUp: 0, ci: [0, 0] as [number, number] };
  const next = random(1);
  const draws = Array.from({ length: n }, () => mean(d.map(() => d[Math.floor(next() * d.length)]!))).sort(
    (x, y) => x - y
  );
  return {
    delta: round(mean(d)),
    pUp: round(draws.filter(m => m > 0).length / n),
    ci: [round(draws[Math.floor(n * 0.025)]!), round(draws[Math.floor(n * 0.975)]!)] as [number, number],
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
    const d = mean(x) - mean(b);
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
export const decide = (t: Pick<Tune, 'keep'>, screen: Eval, full?: Eval): Step['verdict'] =>
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

/**
 * Per case the quality, usd and minutes of every v2 run that was not infra, the count of all runs and their total
 * cost and minutes.
 */
const scores = (rows: Row[], preset: Tune['preset']) => {
  const w = preset === 'hidden' ? { ...presets['hidden tests only']!, suite: 0.15 } : presets.composite!;
  const human = new Map(rows.filter(r => r.point.includes('/human@')).map(r => [r.case, r]));
  type Case = { qs: number[]; paid: number[]; took: number[]; runs: number; usd: number; min: number; infra: boolean };
  const out = new Map<string, Case>();
  for (const r of rows.filter(r => r.point.includes('/v2@'))) {
    const s = out.get(r.case) ?? { qs: [], paid: [], took: [], runs: 0, usd: 0, min: 0, infra: true };
    if (!r.infra) {
      s.qs.push(quality(r, w, undefined, human.get(r.case)));
      s.paid.push(r.usd ?? 0);
      s.took.push(r.minutes);
    }
    out.set(r.case, { ...s, runs: s.runs + 1, usd: s.usd + (r.usd ?? 0), min: s.min + r.minutes, infra: !s.qs.length });
  }
  return out;
};
type Scores = ReturnType<typeof scores>;
const qsOf = (s: Scores, cases: string[]) => Object.fromEntries(cases.map(c => [c, s.get(c)?.qs ?? []]));

const evalOf = (
  candidate: string,
  split: Split,
  cases: string[],
  mine: Scores,
  usage: Pick<Eval, 'codex' | 'claude5h'>,
  incumbent?: Scores,
  runs = 3
): Eval => {
  const qs = cases.map(c => mean(mine.get(c)?.qs ?? []));
  const per = (s: Scores, k: 'paid' | 'took') => cases.map(c => mean(s.get(c)?.[k] ?? []));
  const both = cases.filter(c => mine.get(c)?.paid.length && incumbent?.get(c)?.paid.length);
  const saving = (k: 'paid' | 'took') => {
    const s = both.map(c => round(1 - mean(mine.get(c)![k]) / Math.max(1e-9, mean(incumbent!.get(c)![k]))));
    const p = paired(
      s.map(() => 0),
      s
    );
    return { share: p.delta, pDown: p.pUp };
  };
  const p = incumbent && {
    ...paired(
      cases.map(c => mean(incumbent.get(c)?.qs ?? [])),
      qs
    ),
    flips: flipsOf(qsOf(incumbent, cases), qsOf(mine, cases), runs),
  };
  return {
    candidate,
    split,
    cases,
    quality: round(mean(qs)),
    ci: paired(
      qs.map(() => 0),
      qs
    ).ci,
    ...(p && { delta: p.delta, pUp: p.pUp, flips: p.flips }),
    usd: round(sum(cases.map(c => mine.get(c)?.usd ?? 0))),
    minutes: round(sum(cases.map(c => mine.get(c)?.min ?? 0))),
    perRun: {
      usd: round(mean(per(mine, 'paid').filter(Boolean))),
      minutes: round(mean(per(mine, 'took').filter(Boolean))),
    },
    ...(incumbent &&
      both.length && {
        saved: { usd: saving('paid'), minutes: saving('took') },
      }),
    ...usage,
  };
};

type Job = { id: string; case: string; repeat?: number };
const outOf = (j: Job) => (j.repeat && j.repeat > 1 ? `${j.id}@${j.repeat}` : j.id);
const unitOf = (dir: string, j: Job) => ({ out: join(dir, 'runs', outOf(j)), case: j.case, arm: 'v2' });
/** A job is done once its v2 run is scored or its case is invalid. */
const finished = (dir: string, j: Job) => {
  const at = join(dir, 'runs', outOf(j), j.case);
  return existsSync(join(at, 'v2', 'score.json')) || Boolean(JSON.parse(read(join(at, 'valid.json')) || '{}').invalid);
};
const tuneLog = (dir: string) => (e: object) =>
  appendJsonl(join(dir, 'log.jsonl'), { at: new Date().toISOString(), ...e });
const children = new Set<ChildProcess>();

/** The bench as the tune drives it: one v2 run and score per job, judged on request, `parallel` at a time. */
const bench = {
  run: async (dir: string, t: Tune, jobs: Job[], o: { parallel: number; judged?: boolean; keys?: string }) => {
    const engine = engineAt(t);
    const call = (args: string[], id: string, repeat = 1) =>
      new Promise<number>(done => {
        const child = spawn(
          process.execPath,
          [
            join(agentgraph, 'bin/bench.ts'),
            ...args,
            ...(o.keys ? ['--keys', o.keys] : []),
            ...(repeat > 1 ? ['--repeat', String(repeat)] : []),
          ],
          {
            stdio: ['ignore', 'inherit', 'inherit'],
            env: {
              ...process.env,
              BENCH_HUB: join(dir, 'cands', id, 'hub'),
              BENCH_CACHE: join(tuneRoot(), '.cache'),
              BENCH_ENGINE: engine,
              BENCH_POINT: t.point,
              NODE_OPTIONS: '',
            },
          }
        );
        children.add(child);
        child.on('close', code => (children.delete(child), done(code ?? 1)));
      });
    let queue: Job[] = [];
    const next = async () => {
      for (let j = queue.shift(); j; j = queue.shift()) {
        const [caseDir, out] = [join(dir, 'cases', j.case), join(dir, 'runs', outOf(j))];
        mkdirSync(out, { recursive: true });
        await call(['run', 'v2', caseDir, out, '--repo', t.clone], j.id, j.repeat);
        await call(['score', caseDir, out, '--repo', t.clone], j.id, j.repeat);
        if (o.judged) await call(['judge', caseDir, out, '--pairs', 'human'], j.id, j.repeat);
      }
    };
    writeFileAtomic(join(dir, 'phase.json'), { at: new Date().toISOString(), parallel: o.parallel, jobs });
    const log = tuneLog(dir);
    for (let round = 0, left = jobs; ;) {
      queue = [...left];
      await Promise.all(Array.from({ length: o.parallel }, next));
      left = jobs.filter(j => !finished(dir, j));
      if (!left.length) return;
      const held = left.some(j => busy(join(dir, 'runs', outOf(j), j.case, 'v2')));
      log({ event: 'unfinished', jobs: left.length, held, round });
      if (!held && ++round >= 3) throw new Error(`${left.length} runs unfinished after 3 rounds; rerun to resume`);
      await waitWhileServicesDown(log);
      await sleep(held ? 30_000 : 60_000);
    }
  },
  /** Rows of every run of a candidate, its repeats in `runs/<id>@<k>` included. */
  rows: (dir: string, id: string) =>
    subdirs(join(dir, 'runs'))
      .filter(n => n === id || n.startsWith(`${id}@`))
      .flatMap(n => readBenchRows(join(dir, 'runs', n))),
  codex: () => codexUsed(),
  propose: (o: Parameters<typeof proposeWith>[0]) => proposeWith(o),
};
type Io = typeof bench;

/** The engine dir to run, after checking its `src` tree is the pinned engine's. */
const engineAt = (t: Tune) => {
  const dir = process.env.BENCH_ENGINE ?? agentgraph;
  const tree = (rev: string) =>
    spawnSync('git', ['-C', dir, 'rev-parse', `${rev}:./src`], { encoding: 'utf8' }).stdout.trim();
  if (tree('HEAD') !== tree(t.engine)) throw new Error(`the engine at ${dir} is not the tune's ${t.engine}`);
  return dir;
};

const git = (dir: string, args: string[], o: { hub?: string; index?: string } = {}) =>
  execFileSync('git', ['--git-dir', join(dir, 'hub.git'), ...(o.hub ? ['--work-tree', o.hub] : []), ...args], {
    encoding: 'utf8',
    cwd: o.hub ?? dir,
    env: {
      ...process.env,
      ...(o.index && { GIT_INDEX_FILE: o.index }),
      GIT_AUTHOR_NAME: 'tune',
      GIT_AUTHOR_EMAIL: 'tune@agentgraph.invalid',
      GIT_COMMITTER_NAME: 'tune',
      GIT_COMMITTER_EMAIL: 'tune@agentgraph.invalid',
    },
  }).trim();

/** Commits `cands/<id>/hub` on `parent` as `refs/cand/<id>` and records it as a pending candidate. */
const enqueue = (dir: string, c: Omit<Candidate, 'hub' | 'diff'>) => {
  const hub = join(dir, 'cands', c.id, 'hub');
  const index = join(dir, 'hub.git', `index.${c.id}`);
  git(dir, ['add', '-A', '.'], { hub, index });
  const tree = git(dir, ['write-tree'], { hub, index });
  rmSync(index, { force: true });
  const sha = git(dir, ['commit-tree', tree, ...(c.parent ? ['-p', c.parent] : []), '-m', c.id]);
  git(dir, ['update-ref', `refs/cand/${c.id}`, sha]);
  const cand: Candidate = { ...c, hub: sha, diff: c.parent ? git(dir, ['diff', c.parent, sha]) : '' };
  writeFileAtomic(join(dir, 'cands', c.id, 'candidate.json'), cand);
  if (!existsSync(join(dir, 'cands', c.id, 'proposal.md')))
    writeFileAtomic(join(dir, 'cands', c.id, 'proposal.md'), `${c.rationale}\n`);
  return cand;
};

const incumbentOf = (steps: Step[]) => steps.filter(s => s.verdict === 'kept').at(-1);
const nextIteration = (steps: Step[]) => Math.max(0, ...steps.map(s => s.iteration)) + 1;
const freeId = (dir: string, iteration: number, proposer: string) => {
  const base = `i${pad(iteration)}-${proposer}`;
  for (let n = 1; ; n++)
    if (!existsSync(join(dir, 'cands', n === 1 ? base : `${base}-${n}`))) return n === 1 ? base : `${base}-${n}`;
};

/** Queues a hub dir as a candidate on the incumbent; the next step evaluates it. */
export const propose = (dir: string, from: string, why: string, proposer: Proposer = 'manual') => {
  const { steps } = tuneRows(dir);
  const parent = incumbentOf(steps);
  if (!parent) throw new Error(`no incumbent in ${dir} yet: run init first`);
  const id = freeId(dir, nextIteration(steps), proposer);
  cpSync(resolve(from), join(dir, 'cands', id, 'hub'), { recursive: true });
  return enqueue(dir, { id, iteration: nextIteration(steps), parent: parent.hub, proposer, rationale: why });
};

/** Candidates written but not evaluated yet, after turning each `manual/*.patch` into one. */
const pending = (dir: string, steps: Step[]) => {
  const parent = incumbentOf(steps)!;
  const patches = existsSync(join(dir, 'manual'))
    ? readdirSync(join(dir, 'manual')).filter(n => n.endsWith('.patch'))
    : [];
  for (const name of patches) {
    const patch = join(dir, 'manual', name);
    const hub = join(dir, 'cands', freeId(dir, nextIteration(steps), 'manual'), 'hub');
    cpSync(join(dir, 'cands', parent.id, 'hub'), hub, { recursive: true });
    execFileSync('git', ['apply', patch], { cwd: hub, env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(hub) } });
    const rationale = read(patch)
      .split(/\n\s*\n/)[0]!
      .trim();
    enqueue(dir, {
      id: basename(dirname(hub)),
      iteration: nextIteration(steps),
      parent: parent.hub,
      proposer: 'manual',
      rationale,
    });
    mkdirSync(join(dir, 'manual', 'applied'), { recursive: true });
    renameSync(patch, join(dir, 'manual', 'applied', name));
  }
  const done = new Set(steps.map(s => s.id));
  return (existsSync(join(dir, 'cands')) ? readdirSync(join(dir, 'cands')) : [])
    .filter(id => !done.has(id) && existsSync(join(dir, 'cands', id, 'candidate.json')))
    .map(id => JSON.parse(read(join(dir, 'cands', id, 'candidate.json'))) as Candidate)
    .sort((a, b) => a.id.localeCompare(b.id));
};

/** `r` after reading `now`: a drop means the window reset, so everything read since counts as used. */
export const reading = (r: Reading | undefined, now: number): Reading => ({
  now,
  used: round((r?.used ?? 0) + (!r ? 0 : now >= r.now ? now - r.now : now)),
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
  const b = JSON.parse(read(file) || '{}') as Budget;
  const mark = (r: Reading | undefined, now: number | undefined) => (now === undefined ? r : reading(r, now));
  const codex = mark(b.codex, io.codex());
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
  return round(of(after) - of(before));
};

const append = (dir: string, s: Step) => appendJsonl(join(dir, 'iterations.jsonl'), s);

/** Writes tune.json, the cases and the minimal hub, then evaluates that hub as the first incumbent. */
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
    const splits = JSON.parse(read(o.splits)) as Record<string, string>;
    const meta = (id: string) => JSON.parse(read(join(o.cases, id, 'case.json')) || '{}') as Record<string, unknown>;
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
      spawnSync('git', ['-C', process.env.BENCH_ENGINE ?? agentgraph, ...args], { encoding: 'utf8' }).stdout.trim();
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
    const mined = Object.fromEntries(
      (['setup', 'runner'] as const).flatMap(k => (typeof first[k] === 'string' ? [[k, first[k]]] : []))
    );
    minimal(
      join(dir, 'cands', 'i000-init', 'hub'),
      { ...pickBenchTestCommands(t.repo, (first.tests as string[]) ?? []), ...mined },
      read(join(agentgraph, 'examples', short, 'hub.yaml')).match(/^toolchain: .*$/m)?.[0]
    );
    execFileSync('git', ['init', '-q', '--bare', join(dir, 'hub.git')]);
    writeFileAtomic(join(dir, 'tune.json'), t);
  }
  const { tune: t, steps } = tuneRows(dir);
  if (steps.length) return dir;
  const cand = existsSync(join(dir, 'cands/i000-init/candidate.json'))
    ? (JSON.parse(read(join(dir, 'cands/i000-init/candidate.json'))) as Candidate)
    : enqueue(dir, { id: 'i000-init', iteration: 0, parent: '', proposer: 'manual', rationale: 'The minimal hub.' });
  git(dir, ['update-ref', 'refs/heads/main', cand.hub]);
  const select = ids(t, 'fit', 'validate');
  const before = guard(dir, io, o.limits ?? limitsDefault);
  await io.run(
    dir,
    t,
    select.map(c => ({ id: cand.id, case: c })),
    { parallel: o.parallel ?? 6, ...(o.keys && { keys: o.keys }) }
  );
  const after = guard(dir, io, o.limits ?? limitsDefault);
  const mine = scores(io.rows(dir, cand.id), t.preset);
  const usage = { codex: spent(before, after, 'codex'), claude5h: 0 };
  const evals = (['fit', 'validate'] as const)
    .filter(s => ids(t, s).length)
    .map((s, i) => evalOf(cand.id, s, ids(t, s), mine, i ? { codex: 0, claude5h: 0 } : usage));
  append(dir, { ...cand, evals, verdict: 'kept', why: 'the starting hub', at: new Date().toISOString() });
  return dir;
};

/**
 * The bench hub with no reviewer: implement with two tries against a tests check, then a human merge. A repo with a
 * toolchain line builds through the toolchain step, so the case plan's host setup is left out.
 */
const minimal = (hub: string, commands: ReturnType<typeof pickBenchTestCommands>, toolchain?: string) => {
  cpSync(join(agentgraph, 'examples/bench'), hub, { recursive: true });
  rmSync(join(hub, 'agents/reviewer.md'), { force: true });
  rmSync(join(hub, 'scripts/review.mjs'), { force: true });
  writeFileAtomic(
    join(hub, 'workflows/issue.md'),
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
    join(hub, 'checks/tests.md'),
    read(join(hub, 'checks/tests.md')).replace('npm test', 'sh "$AGENTGRAPH_HUB/scripts/tests.sh"')
  );
  const each = commands.runner
    ? `[ -z "$files" ] || ${commands.runner} $files`
    : `for f in $files; do
  d=$(dirname "$f")
  while [ "$d" != . ] && [ ! -f "$d/package.json" ]; do d=$(dirname "$d"); done
  if grep -q '"jest"' "$d/package.json"; then (cd "$d" && npx jest --runTestsByPath "\${f#"$d"/}") || exit 1
  else (cd "$d" && npx vitest run "\${f#"$d"/}") || exit 1; fi
done`;
  writeFileAtomic(
    join(hub, 'scripts/tests.sh'),
    `set -f\nfiles=$(git ls-files -mo --exclude-standard | grep -E '[.](test|spec)[.][jt]sx?$')\n${each}\n`
  );
  if (toolchain) writeFileAtomic(join(hub, 'hub.yaml'), `${toolchain}\n${read(join(hub, 'hub.yaml'))}`);
  else if (commands.setup)
    writeFileAtomic(join(hub, 'hub.yaml'), `setup: ${JSON.stringify(commands.setup)}\n${read(join(hub, 'hub.yaml'))}`);
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
  } = {},
  io: Io = bench
) => {
  const { tune: t, steps } = tuneRows(dir);
  const inc = incumbentOf(steps);
  if (!inc) throw new Error(`no incumbent in ${dir}: run init`);
  const limits = o.limits ?? limitsDefault;
  const iteration = nextIteration(steps);
  const claude: Record<string, number> = { ...o.claude };
  const queued = pending(dir, steps);
  const auto = ['retro', 'history', 'structure'] as const;
  const failed: string[] = [];
  for (const proposer of auto.filter(p => (o.proposers ?? ['retro', 'history']).includes(p))) {
    if (queued.length >= (o.k ?? 3)) break;
    const id = freeId(dir, iteration, proposer);
    const before = guard(dir, io, limits);
    const runs = join(dir, 'runs', inc.id);
    const made = await io
      .propose({ tune: dir, id, proposer, from: join(dir, 'cands', inc.id, 'hub'), runs, iteration })
      .catch((e: unknown) => void failed.push(`${id}: ${String(e)}`));
    if (!made?.hub) continue;
    const after = guard(dir, io, limits, made.usage);
    claude[id] = spent(before, after, 'fiveHour');
    queued.push(enqueue(dir, { id, iteration, parent: inc.hub, proposer, rationale: made.rationale }));
  }
  for (const f of failed) console.error(f);
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
    return round(spent(before, guard(dir, io, limits), 'codex') / Math.max(1, per));
  };
  const cross = (cands: Candidate[], cases: string[]) => cands.flatMap(c => cases.map(k => ({ id: c.id, case: k })));
  const usage = (c: Candidate, codex: number) => ({ codex, claude5h: claude[c.id] ?? 0 });
  const screenCodex = await phase(cross(queued, screened), queued.length);
  const before = theirs();
  const results = queued.map(c => {
    const mine = scores(io.rows(dir, c.id), t.preset);
    const screen = evalOf(c.id, 'fit', screened, mine, usage(c, screenCodex), before, runs);
    const infra = screened.filter(k => mine.get(k)?.infra !== false).length > screened.length / 2;
    return { c, screen, evals: [screen], verdict: infra ? ('infra' as const) : decide(t, screen) };
  });
  const survivors = results.filter(r => r.verdict === 'discarded');
  const fullCodex = await phase(
    cross(
      survivors.map(r => r.c),
      rest
    ),
    survivors.length
  );
  const repeats = (id: string, s: Scores, cases: string[]) =>
    cases.flatMap(k => {
      const { qs = [], runs: n = 0 } = s.get(k) ?? {};
      return Array.from({ length: Math.max(0, runs - qs.length) }, (_, i) => ({ id, case: k, repeat: n + i + 1 }));
    });
  const now = theirs();
  const flipped = survivors.flatMap(r => {
    const mine = scores(io.rows(dir, r.c.id), t.preset);
    const f = flipsOf(qsOf(now, select), qsOf(mine, select), runs);
    const open = Object.keys(f).filter(k => f[k] === 'up' || f[k] === 'down');
    return Object.values(f).includes('up') && open.length ? [{ id: r.c.id, mine, open }] : [];
  });
  const shared = [...new Set(flipped.flatMap(f => f.open))];
  const confirmCodex = await phase(
    [...repeats(inc.id, now, shared), ...flipped.flatMap(f => repeats(f.id, f.mine, f.open))],
    flipped.length
  );
  const after = theirs();
  const full = survivors.map(r => {
    const mine = scores(io.rows(dir, r.c.id), t.preset);
    const codex = fullCodex + (flipped.some(f => f.id === r.c.id) ? confirmCodex : 0);
    const parts = (['fit', 'validate'] as const)
      .map(s => [s, rest.filter(k => t.cases[k] === s)] as const)
      .filter(([, cases]) => cases.length);
    const splits = parts.map(([s, cases]) =>
      evalOf(r.c.id, s, cases, mine, { codex: round(codex / parts.length), claude5h: 0 }, after, runs)
    );
    const all = evalOf(r.c.id, 'fit', select, mine, usage(r.c, 0), after, runs);
    const screen = evalOf(r.c.id, 'fit', screened, mine, usage(r.c, screenCodex), after, runs);
    return { ...r, evals: [screen, ...splits], all, verdict: decide(t, r.screen, all) };
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
        ? `, usd ${round(-s.usd.share)} and minutes ${round(-s.minutes.share)} per run (P ${s.usd.pDown}, ${s.minutes.pDown})`
        : '';
    const on = (e: Eval) =>
      `won ${named(e, 'win')}, lost ${named(e, 'loss')}, delta ${e.delta} over ${e.cases.length} cases${cost(e)}`;
    if (r.verdict === 'infra') return 'most screen runs said nothing (infra)';
    if (r.verdict === 'screened-out') return `screen dropped ${named(r.screen, 'down', 'loss')}`;
    if (!r.all) return 'no select cases beyond the screen';
    if (r === best) return `select ${on(r.all)}`;
    return r.verdict === 'kept' ? `select ${on(r.all)}, beaten by ${best!.c.id}` : `select ${on(r.all)}, below the bar`;
  };
  const out: Step[] = [...results.filter(r => r.verdict !== 'discarded'), ...full].map(r => ({
    ...r.c,
    evals: r.evals,
    verdict: r === best ? 'kept' : r.verdict === 'kept' ? 'discarded' : r.verdict,
    why: why(r),
    at: new Date().toISOString(),
  }));
  for (const s of out) append(dir, s);
  if (best) git(dir, ['update-ref', 'refs/heads/main', best.c.hub]);
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
    test.map(c => ({ id: inc.id, case: c })),
    { parallel: o.parallel ?? 6, judged: true, ...(o.keys && { keys: o.keys }) }
  );
  const e = evalOf(inc.id, 'test', test, scores(io.rows(dir, inc.id), 'composite'), { codex: 0, claude5h: 0 });
  const lines = steps.map(s => (s === inc ? { ...s, evals: [...s.evals, e] } : s));
  writeFileAtomic(join(dir, 'iterations.jsonl'), lines.map(s => `${JSON.stringify(s)}\n`).join(''));
  return e;
};

/** Iterations at the end of the tune in a row that kept nothing. */
const flatOf = (steps: Step[]) => {
  const kept = new Set(steps.filter(s => s.verdict === 'kept').map(s => s.iteration));
  const last = nextIteration(steps) - 1;
  let n = 0;
  while (last - n > 0 && !kept.has(last - n)) n++;
  return n;
};

/** Whether the incumbent is every third keep and has no test eval yet. */
const due = (steps: Step[]) => {
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
 * runs it, and where the current phase of runs stands.
 * @internal
 */
export const status = (dir: string, limits = limitsDefault) => {
  const { tune: t, steps } = tuneRows(dir);
  const inc = incumbentOf(steps);
  const q = (es: Eval[]) => {
    const n = sum(es.map(e => e.cases.length));
    return n ? `${round(sum(es.map(e => e.quality * e.cases.length)) / n)} on ${n}` : '-';
  };
  const on = (...splits: Split[]) => q(inc?.evals.filter(e => splits.includes(e.split)) ?? []);
  const b = JSON.parse(read(join(dir, 'budget.json')) || '{}') as Budget;
  const used = (name: string, r: Reading | undefined, max: number) => `${name} ${r?.used ?? '-'} of ${max}`;
  const live = Boolean(read(join(dir, 'tune.lock'))) && busy(join(dir, 'tune'));
  const pid = Number(read(join(dir, 'tune.lock')) || 0);
  const phase = JSON.parse(read(join(dir, 'phase.json')) || 'null') as {
    at: string;
    parallel: number;
    jobs: Job[];
  } | null;
  const last = readJsonl(join(dir, 'log.jsonl')).at(-1);
  const written = Math.max(
    0,
    ...[dir, ...subdirs(join(dir, 'runs')).map(n => join(dir, 'runs', n))]
      .map(d => join(d, 'log.jsonl'))
      .filter(existsSync)
      .map(f => statSync(f).mtimeMs)
  );
  const ofPhase = (p: { parallel: number; jobs: Job[] }) => {
    const { eta, ...rest } = progress(
      p.jobs.map(j => unitOf(dir, j)),
      p.parallel
    );
    return live && eta !== undefined ? { ...rest, eta } : rest;
  };
  return [
    `${t.repo} on ${t.point}: ${steps.length} steps over ${nextIteration(steps) - 1} iterations, incumbent ${inc?.id ?? 'none yet'}`,
    `  quality, human = 1: select ${on('fit', 'validate')}, validate ${on('validate')}, test ${on('test')}`,
    `  points used: ${used('Codex', b.codex, limits.codex)}, ${used('Claude 5h', b.claude?.fiveHour, limits.claude5h)}, ${used('Claude week', b.claude?.week, limits.claudeWeek)}`,
    `  bench runs: $${round(sum(steps.flatMap(s => s.evals.map(e => e.usd))))}, ${Math.round(sum(steps.flatMap(s => s.evals.map(e => e.minutes))))} min`,
    ...steps.slice(-5).map(s => `  ${s.id} ${s.verdict}: ${s.why}`),
    live ? `running as pid ${pid}` : 'no live lock',
    written ? `last log write ${Math.round((Date.now() - written) / 60_000)} min ago` : 'no log yet',
    ...(last ? [`last event: ${JSON.stringify(last)}`] : []),
    ...(phase ? [`phase since ${phase.at}:`, statusText(ofPhase(phase))] : []),
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
      console.error(`another process runs ${dir}: ${read(join(dir, 'tune.lock'))}`);
      process.exit(1);
    }
    process.on('exit', () => release(join(dir, 'tune')));
    const env = ensureRunSettingsPinned(join(dir, 'env.json'), {
      ...readBenchResultEnv(),
      ...(o.keys && { keys: o.keys }),
    });
    for (const [k, v] of Object.entries(env)) if (k.startsWith('BENCH_')) process.env[k] ??= v;
    if (env.keys) Object.assign(o, { keys: env.keys });
    onStop(signal => {
      tuneLog(dir)({ event: 'paused', signal });
      for (const child of children) child.kill('SIGTERM');
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
    console.log(propose(resolve(target), values.from, values.why, values.as as Proposer).id);
  else {
    console.error(
      'usage: node bin/tune.ts (init <repo> --cases --splits --repos --point | step | run [--until n] | checkpoint | status | propose --from --why) <tune dir>'
    );
    process.exit(2);
  }
}
