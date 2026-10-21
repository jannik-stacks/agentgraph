/**
 * Hill-climbs a hub on one repo's replayed pull requests: each step evaluates candidate hubs with the bench and keeps
 * one only when it beats the incumbent on the select cases (fit plus validate).
 * Usage: node bin/tune.ts init <repo> --cases <dir> --splits <file> --repos <dir> --point opencode:luna [--name t1]
 *        node bin/tune.ts step <tune dir> [--k 3] [--proposers retro,history,manual] [--parallel 6]
 *        node bin/tune.ts run <tune dir> --iterations 8 [--max-codex 25] [--max-claude-5h 40] [--max-claude-week 12]
 *        node bin/tune.ts checkpoint <tune dir>
 *        node bin/tune.ts propose <tune dir> --from <hub dir> --why <text> [--as manual|skill]
 * Tunes live in ~/bothub-data/tune/<repo>/<name> (BOTHUB_TUNE moves the root).
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { presets, quality } from '../studio/src/bench/score.ts';
import { codexUsed, plan, rowsOf } from './bench.ts';

type Split = 'mine' | 'fit' | 'validate' | 'test';
type Tune = {
  repo: string;
  engine: string;
  point: string;
  cases: Record<string, Split>;
  preset: 'hidden' | 'composite';
  keep: { p: number; delta: number; screen: number };
  clone: string;
};
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
  usd: number;
  minutes: number;
  codex: number;
  claude5h: number;
};
type Step = Candidate & {
  evals: Eval[];
  verdict: 'kept' | 'discarded' | 'screened-out' | 'infra';
  why: string;
  at: string;
};
type Row = ReturnType<typeof rowsOf>[number];
type Reading = { start: number; now: number };
type Budget = { codex?: Reading; claude?: { fiveHour?: Reading; week?: Reading } };
type Proposal = { rationale: string; raw?: string; claude?: { fiveHour: number; week: number } };

const bothub = join(import.meta.dirname, '..');
const tuneRoot = () => process.env.BOTHUB_TUNE ?? join(homedir(), 'bothub-data/tune');
const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
const save = (path: string, v: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof v === 'string' ? v : `${JSON.stringify(v, null, 2)}\n`);
};
const round = (n: number) => Math.round(n * 1000) / 1000;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : 0);
const sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0);
const pad = (n: number) => String(n).padStart(3, '0');

/** The tune's settings and its steps in order, as `iterations.jsonl` holds them. */
export const tuneRows = (dir: string) => ({
  tune: JSON.parse(read(join(dir, 'tune.json'))) as Tune,
  steps: read(join(dir, 'iterations.jsonl'))
    .split('\n')
    .flatMap(l => (l ? [JSON.parse(l) as Step] : [])),
});

const subdirs = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap(e =>
        e.isDirectory() && !e.name.startsWith('.') ? [e.name] : []
      )
    : [];

/** Every tune under `root`, keyed `<repo>/<name>`. */
export const tunesOf = (root = tuneRoot()) =>
  subdirs(root).flatMap(repo =>
    subdirs(join(root, repo))
      .filter(name => existsSync(join(root, repo, name, 'tune.json')))
      .map(name => ({ key: `${repo}/${name}`, ...tuneRows(join(root, repo, name)) }))
  );

const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

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

/** Out on a clear screen loss; kept only when the full run gains enough, with enough confidence. */
export const decide = (t: Pick<Tune, 'keep'>, screen: Eval, full?: Eval): Step['verdict'] =>
  (screen.delta ?? 0) < -t.keep.screen
    ? 'screened-out'
    : full && (full.delta ?? 0) >= t.keep.delta && (full.pUp ?? 0) >= t.keep.p
      ? 'kept'
      : 'discarded';

const ids = (t: Tune, ...splits: Split[]) =>
  Object.keys(t.cases)
    .filter(id => splits.includes(t.cases[id]!))
    .sort();

/** Per case quality, cost and minutes of the v2 rows; an infra row scores 0. */
const scores = (rows: Row[], preset: Tune['preset']) => {
  const w = preset === 'hidden' ? { ...presets['hidden tests only']!, suite: 0.15 } : presets.composite!;
  const human = new Map(rows.filter(r => r.point.includes('/human@')).map(r => [r.case, r]));
  return new Map(
    rows
      .filter(r => r.point.includes('/v2@'))
      .map(r => [
        r.case,
        {
          q: r.infra ? 0 : quality(r, w, undefined, human.get(r.case)),
          usd: r.usd ?? 0,
          min: r.minutes,
          infra: !!r.infra,
        },
      ])
  );
};
type Scores = ReturnType<typeof scores>;

const evalOf = (
  candidate: string,
  split: Split,
  cases: string[],
  mine: Scores,
  usage: Pick<Eval, 'codex' | 'claude5h'>,
  incumbent?: Scores
): Eval => {
  const qs = cases.map(c => mine.get(c)?.q ?? 0);
  const p =
    incumbent &&
    paired(
      cases.map(c => incumbent.get(c)?.q ?? 0),
      qs
    );
  return {
    candidate,
    split,
    cases,
    quality: round(mean(qs)),
    ci: paired(
      qs.map(() => 0),
      qs
    ).ci,
    ...(p && { delta: p.delta, pUp: p.pUp }),
    usd: round(sum(cases.map(c => mine.get(c)?.usd ?? 0))),
    minutes: round(sum(cases.map(c => mine.get(c)?.min ?? 0))),
    ...usage,
  };
};

/** The bench as the tune drives it: one v2 run and score per job, judged on request, `parallel` at a time. */
const bench = {
  run: async (
    dir: string,
    t: Tune,
    jobs: { id: string; case: string }[],
    o: { parallel: number; judged?: boolean; keys?: string }
  ) => {
    const engine = engineAt(t);
    const call = (args: string[], id: string) =>
      new Promise<number>(done =>
        spawn(process.execPath, [join(bothub, 'bin/bench.ts'), ...args, ...(o.keys ? ['--keys', o.keys] : [])], {
          stdio: ['ignore', 'inherit', 'inherit'],
          env: {
            ...process.env,
            BENCH_HUB: join(dir, 'cands', id, 'hub'),
            BENCH_CACHE: join(tuneRoot(), '.cache'),
            BENCH_ENGINE: engine,
            BENCH_POINT: t.point,
            NODE_OPTIONS: '',
          },
        }).on('close', code => done(code ?? 1))
      );
    const queue = [...jobs];
    const next = async () => {
      for (let j = queue.shift(); j; j = queue.shift()) {
        const [caseDir, out] = [join(dir, 'cases', j.case), join(dir, 'runs', j.id)];
        mkdirSync(out, { recursive: true });
        await call(['run', 'v2', caseDir, out, '--repo', t.clone], j.id);
        await call(['score', caseDir, out, '--repo', t.clone], j.id);
        if (o.judged) await call(['judge', caseDir, out, '--judges', 'opus:1,sol:1', '--pairs', 'human'], j.id);
      }
    };
    await Promise.all(Array.from({ length: o.parallel }, next));
  },
  rows: (dir: string, id: string) => (existsSync(join(dir, 'runs', id)) ? rowsOf(join(dir, 'runs', id)) : []),
  codex: () => codexUsed(),
  propose: async (o: { dir: string; proposer: Proposer; id: string; incumbent: string }) => {
    const file = join(bothub, 'tune/propose.ts');
    if (!existsSync(file)) return undefined;
    const { propose } = (await import(file)) as { propose: (x: typeof o) => Promise<Proposal | undefined> };
    return propose(o);
  },
};
type Io = typeof bench;

/** The engine dir to run, after checking its `src` tree is the pinned engine's. */
const engineAt = (t: Tune) => {
  const dir = process.env.BENCH_ENGINE ?? bothub;
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
      GIT_AUTHOR_EMAIL: 'tune@bothub.invalid',
      GIT_COMMITTER_NAME: 'tune',
      GIT_COMMITTER_EMAIL: 'tune@bothub.invalid',
    },
  }).trim();

/** Commits `cands/<id>/hub` on `parent` as `refs/cand/<id>` and records it as a pending candidate. */
const enqueue = (dir: string, c: Omit<Candidate, 'hub' | 'diff'>, raw = '') => {
  const hub = join(dir, 'cands', c.id, 'hub');
  const index = join(dir, 'hub.git', `index.${c.id}`);
  git(dir, ['add', '-A', '.'], { hub, index });
  const tree = git(dir, ['write-tree'], { hub, index });
  rmSync(index, { force: true });
  const sha = git(dir, ['commit-tree', tree, ...(c.parent ? ['-p', c.parent] : []), '-m', c.id]);
  git(dir, ['update-ref', `refs/cand/${c.id}`, sha]);
  const cand: Candidate = { ...c, hub: sha, diff: c.parent ? git(dir, ['diff', c.parent, sha]) : '' };
  save(join(dir, 'cands', c.id, 'candidate.json'), cand);
  save(join(dir, 'cands', c.id, 'proposal.md'), `${c.rationale}\n${raw && `\n---\n\n${raw}\n`}`);
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

/** Reads the guards, records them, and throws past a cap. */
const guard = (dir: string, io: Pick<Io, 'codex'>, limits: Limits, claude?: Proposal['claude']) => {
  const file = join(dir, 'budget.json');
  const b = JSON.parse(read(file) || '{}') as Budget;
  const mark = (r: Reading | undefined, now: number | undefined) =>
    now === undefined ? r : { start: r?.start ?? now, now };
  const codex = mark(b.codex, io.codex());
  const fiveHour = mark(b.claude?.fiveHour, claude && claude.fiveHour * 100);
  const week = mark(b.claude?.week, claude && claude.week * 100);
  const next: Budget = { ...(codex && { codex }), claude: { ...(fiveHour && { fiveHour }), ...(week && { week }) } };
  save(file, next);
  const used = (r?: Reading) => (r ? r.now - r.start : 0);
  for (const [name, r, max] of [
    ['Codex weekly', codex, limits.codex],
    ['Claude 5h', fiveHour, limits.claude5h],
    ['Claude weekly', week, limits.claudeWeek],
  ] as const)
    if (used(r) > max) throw new Error(`${name} use is ${r!.now}%, more than ${max} points over ${r!.start}%`);
  return next;
};
type Limits = { codex: number; claude5h: number; claudeWeek: number };
const limitsDefault: Limits = { codex: 25, claude5h: 40, claudeWeek: 12 };

const append = (dir: string, s: Step) => appendFileSync(join(dir, 'iterations.jsonl'), `${JSON.stringify(s)}\n`);

/** Writes tune.json, the cases and the minimal hub, then evaluates that hub as the first incumbent. */
export const init = async (
  repo: string,
  o: { cases: string; splits: string; repos: string; point: string; name?: string; parallel?: number; keys?: string },
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
    const engine = spawnSync('git', ['-C', process.env.BENCH_ENGINE ?? bothub, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    });
    const t: Tune = {
      repo: String(meta(gated[0] ?? '').repo ?? repo),
      engine: engine.stdout.trim(),
      point: o.point,
      cases,
      preset: 'hidden',
      keep: { p: 0.8, delta: 0.03, screen: 0.2 },
      clone: resolve(o.repos, short),
    };
    minimal(
      join(dir, 'cands', 'i000-init', 'hub'),
      plan(t.repo, (meta(train[0] ?? gated[0] ?? '').tests as string[]) ?? [])
    );
    execFileSync('git', ['init', '-q', '--bare', join(dir, 'hub.git')]);
    save(join(dir, 'tune.json'), t);
  }
  const { tune: t, steps } = tuneRows(dir);
  if (steps.length) return dir;
  const cand = existsSync(join(dir, 'cands/i000-init/candidate.json'))
    ? (JSON.parse(read(join(dir, 'cands/i000-init/candidate.json'))) as Candidate)
    : enqueue(dir, { id: 'i000-init', iteration: 0, parent: '', proposer: 'manual', rationale: 'The minimal hub.' });
  git(dir, ['update-ref', 'refs/heads/main', cand.hub]);
  const select = ids(t, 'fit', 'validate');
  const before = guard(dir, io, limitsDefault);
  await io.run(
    dir,
    t,
    select.map(c => ({ id: cand.id, case: c })),
    { parallel: o.parallel ?? 6, ...(o.keys && { keys: o.keys }) }
  );
  const after = guard(dir, io, limitsDefault);
  const mine = scores(io.rows(dir, cand.id), t.preset);
  const usage = { codex: round((after.codex?.now ?? 0) - (before.codex?.now ?? 0)), claude5h: 0 };
  const evals = (['fit', 'validate'] as const).flatMap(s =>
    ids(t, s).length ? [evalOf(cand.id, s, ids(t, s), mine, usage)] : []
  );
  append(dir, { ...cand, evals, verdict: 'kept', why: 'the starting hub', at: new Date().toISOString() });
  return dir;
};

/** The bench hub with no reviewer: implement with two tries against a tests check, then a human merge. */
const minimal = (hub: string, commands: ReturnType<typeof plan>) => {
  cpSync(join(bothub, 'examples/bench'), hub, { recursive: true });
  rmSync(join(hub, 'agents/reviewer.md'));
  rmSync(join(hub, 'scripts/review.mjs'));
  save(
    join(hub, 'workflows/issue.md'),
    `---
on: { issue_comment: { command: /bothub } }
branch: bothub/{issue}
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
  save(
    join(hub, 'checks/tests.md'),
    read(join(hub, 'checks/tests.md')).replace('npm test', 'sh "$BOTHUB_HUB/scripts/tests.sh"')
  );
  const each = commands.runner
    ? `[ -z "$files" ] || ${commands.runner} $files`
    : `for f in $files; do
  d=$(dirname "$f")
  while [ "$d" != . ] && [ ! -f "$d/package.json" ]; do d=$(dirname "$d"); done
  if grep -q '"jest"' "$d/package.json"; then (cd "$d" && npx jest --runTestsByPath "\${f#"$d"/}") || exit 1
  else (cd "$d" && npx vitest run "\${f#"$d"/}") || exit 1; fi
done`;
  save(
    join(hub, 'scripts/tests.sh'),
    `set -f\nfiles=$(git ls-files -mo --exclude-standard | grep -E '[.](test|spec)[.][jt]sx?$')\n${each}\n`
  );
  if (commands.setup)
    save(join(hub, 'hub.yaml'), `setup: ${JSON.stringify(commands.setup)}\n${read(join(hub, 'hub.yaml'))}`);
};

/** One iteration: proposals, a screen on a few fit cases, the survivors on the rest of select, at most one kept. */
export const step = async (
  dir: string,
  o: { k?: number; proposers?: Proposer[]; parallel?: number; limits?: Limits; keys?: string } = {},
  io: Io = bench
) => {
  const { tune: t, steps } = tuneRows(dir);
  const inc = incumbentOf(steps);
  if (!inc) throw new Error(`no incumbent in ${dir}: run init`);
  const limits = o.limits ?? limitsDefault;
  const iteration = nextIteration(steps);
  const claude: Record<string, number> = {};
  const queued = pending(dir, steps);
  for (const proposer of (o.proposers ?? ['retro', 'history']).filter(p => p !== 'manual')) {
    if (queued.length >= (o.k ?? 3)) break;
    const id = freeId(dir, iteration, proposer);
    const before = guard(dir, io, limits);
    const made = await io.propose({ dir, proposer, id, incumbent: inc.id });
    if (!made || !existsSync(join(dir, 'cands', id, 'hub'))) continue;
    const after = guard(dir, io, limits, made.claude);
    claude[id] = round(
      (after.claude?.fiveHour?.now ?? 0) - (before.claude?.fiveHour?.now ?? after.claude?.fiveHour?.now ?? 0)
    );
    queued.push(enqueue(dir, { id, iteration, parent: inc.hub, proposer, rationale: made.rationale }, made.raw));
  }
  if (!queued.length) return [];
  const theirs = scores(io.rows(dir, inc.id), t.preset);
  const fit = ids(t, 'fit');
  const offset = ((iteration - 1) * 4) % Math.max(1, fit.length);
  const screened = [...fit.slice(offset), ...fit.slice(0, offset)].slice(0, 4);
  const rest = ids(t, 'fit', 'validate').filter(c => !screened.includes(c));
  const phase = async (cands: Candidate[], cases: string[]) => {
    const before = guard(dir, io, limits);
    const jobs = cands.flatMap(c => cases.map(k => ({ id: c.id, case: k })));
    await io.run(dir, t, jobs, { parallel: o.parallel ?? 6, ...(o.keys && { keys: o.keys }) });
    const after = guard(dir, io, limits);
    return round(((after.codex?.now ?? 0) - (before.codex?.now ?? 0)) / Math.max(1, cands.length));
  };
  const usage = (c: Candidate, codex: number) => ({ codex, claude5h: claude[c.id] ?? 0 });
  const screenCodex = await phase(queued, screened);
  const results = queued.map(c => {
    const mine = scores(io.rows(dir, c.id), t.preset);
    const screen = evalOf(c.id, 'fit', screened, mine, usage(c, screenCodex), theirs);
    const infra = screened.filter(k => mine.get(k)?.infra !== false).length > screened.length / 2;
    return { c, screen, evals: [screen], verdict: infra ? ('infra' as const) : decide(t, screen) };
  });
  const survivors = results.filter(r => r.verdict === 'discarded');
  const fullCodex =
    rest.length && survivors.length
      ? await phase(
          survivors.map(r => r.c),
          rest
        )
      : 0;
  const select = [...screened, ...rest];
  const full = survivors.map(r => {
    const mine = scores(io.rows(dir, r.c.id), t.preset);
    const splits = (['fit', 'validate'] as const).flatMap(s => {
      const cases = rest.filter(k => t.cases[k] === s);
      return cases.length ? [evalOf(r.c.id, s, cases, mine, usage(r.c, fullCodex / 2), theirs)] : [];
    });
    const all = evalOf(r.c.id, 'fit', select, mine, usage(r.c, 0), theirs);
    return { ...r, evals: [r.screen, ...splits], all, verdict: decide(t, r.screen, all) };
  });
  const best = full.filter(r => r.verdict === 'kept').sort((a, b) => (b.all.delta ?? 0) - (a.all.delta ?? 0))[0];
  const why = (r: (typeof results)[number] & { all?: Eval }) => {
    const on = (e: Eval) => `${e.delta} over ${e.cases.length} cases, P(gain) ${e.pUp}`;
    if (r.verdict === 'infra') return 'most screen runs said nothing (infra)';
    if (r.verdict === 'screened-out') return `screen loss ${on(r.screen)}`;
    if (!r.all) return 'no select cases beyond the screen';
    if (r === best) return `select gain ${on(r.all)}`;
    return r.verdict === 'kept'
      ? `select gain ${on(r.all)}, beaten by ${best!.c.id}`
      : `select gain ${on(r.all)}, below the bar`;
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
  save(join(dir, 'iterations.jsonl'), lines.map(s => `${JSON.stringify(s)}\n`).join(''));
  return e;
};

/** Steps until `iterations`, three steps in a row keep nothing, or a guard stops it; checkpoints every third keep. */
export const run = async (dir: string, o: Parameters<typeof step>[1] & { iterations: number }, io: Io = bench) => {
  let flat = 0;
  for (let i = 0; i < o.iterations && flat < 3; i++) {
    const made = await step(dir, o, io);
    const kept = made.some(s => s.verdict === 'kept');
    flat = kept ? 0 : flat + 1;
    if (kept && tuneRows(dir).steps.filter(s => s.verdict === 'kept').length % 3 === 1) await checkpoint(dir, o, io);
  }
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
  else if (command === 'run' && target) await run(resolve(target), { ...o, iterations: Number(values.iterations) });
  else if (command === 'checkpoint' && target) print(await checkpoint(resolve(target), o));
  else if (command === 'propose' && target && values.from && values.why)
    console.log(propose(resolve(target), values.from, values.why, values.as as Proposer).id);
  else {
    console.error(
      'usage: node bin/tune.ts (init <repo> --cases --splits --repos --point | step | run | checkpoint | propose --from --why) <tune dir>'
    );
    process.exit(2);
  }
}
