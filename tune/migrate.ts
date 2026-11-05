import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Effect } from 'effect';
import { readRunLabels, writeRunLabels } from '../src/labels.ts';
import { getRunOrigin } from '../src/meta.ts';
import { readJsonlRows, readRecordSync, writeFileAtomic } from '../src/store.ts';
import type { RunRecord } from '../src/workflow.ts';
import {
  getTuneLabel,
  readTuneSteps,
  type Eval,
  type TuneStep,
  type Variant,
  writeVariantDecision,
  writeVariantRun,
  writeVariantTest,
} from './runs.ts';

type OldStep = Omit<TuneStep, 'parent' | 'base' | 'evals'> & {
  parent: string;
  diff: string;
  evals: (Omit<Eval, 'variant'> & { candidate: string })[];
};
type OldCandidate = Pick<OldStep, 'id' | 'iteration' | 'parent' | 'proposer' | 'graph' | 'rationale' | 'diff'>;
type Labelled = { labels?: Record<string, string> };

const readJson = <T>(path: string) => (existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : undefined);
const readNames = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter(n => !n.startsWith('.')) : []);
const git = (dir: string, args: string[]) =>
  execFileSync('git', [`--git-dir=${join(dir, 'graph.git')}`, ...args], { encoding: 'utf8' }).trim();

const renameCand = <T extends Labelled>(i: T): T => {
  const { cand, ...labels } = i.labels ?? {};
  return cand === undefined ? i : { ...i, labels: { ...labels, variant: cand } };
};

export const readTuneMigration = (dir: string) => {
  const problems: string[] = [];
  if (!existsSync(join(dir, 'graph.git')))
    problems.push(existsSync(join(dir, 'hub.git')) ? 'has hub.git, not graph.git' : 'has no graph.git');
  if (!existsSync(join(dir, 'data'))) problems.push('has no data/: run bench/flatten.ts first');
  const found = readTuneSteps(dir);
  if (found.steps.length + found.pending.length) problems.push('already has control runs');
  const steps = readJsonlRows(join(dir, 'iterations.jsonl')) as OldStep[];
  const done = new Set(steps.map(s => s.id));
  const pending = readNames(join(dir, 'cands')).flatMap(id => {
    const c = done.has(id) ? undefined : readJson<OldCandidate>(join(dir, 'cands', id, 'candidate.json'));
    return c ? [c] : [];
  });
  const byGraph = new Map([...steps, ...pending].map(c => [c.graph, c.id]));
  const toVariant = (c: OldCandidate): Variant => ({
    id: c.id,
    iteration: c.iteration,
    parent: c.parent ? (byGraph.get(c.parent) ?? '') : '',
    base: c.parent,
    graph: c.graph,
    proposer: c.proposer,
    rationale: c.rationale,
  });
  for (const c of [...steps, ...pending])
    if (c.parent && !byGraph.has(c.parent)) problems.push(`${c.id}: no variant has its parent graph ${c.parent}`);
  const iterations = new Map([...steps, ...pending].map(c => [c.id, c.iteration]));
  const runs = readNames(join(dir, 'data')).flatMap(id => {
    const json = readRecordSync(join(dir, 'data', id, 'run.json'));
    const run = json ? (JSON.parse(json) as RunRecord) : undefined;
    const cand = (getRunOrigin(run?.meta)?.input as Labelled | undefined)?.labels?.cand;
    return run && cand ? [{ run, cand, iteration: iterations.get(cand) }] : [];
  });
  for (const r of runs) if (r.iteration === undefined) problems.push(`run ${r.run.id}: no variant ${r.cand}`);
  const attempts = readNames(join(dir, 'attempts')).filter(a =>
    Boolean(readJson<Labelled>(join(dir, 'attempts', a, 'input.json'))?.labels?.cand)
  );
  const refs = existsSync(join(dir, 'graph.git'))
    ? git(dir, ['for-each-ref', '--format=%(refname)', 'refs/cand/']).split('\n').filter(Boolean)
    : [];
  return {
    steps: steps.map(s => ({
      ...toVariant(s),
      verdict: s.verdict,
      why: s.why,
      at: s.at,
      evals: s.evals.map(({ candidate, ...e }) => ({ ...e, variant: candidate })),
      diff: s.diff,
    })),
    pending: pending.map(c => ({ ...toVariant(c), diff: c.diff })),
    runs,
    attempts,
    refs,
    problems,
  };
};

export const writeTuneMigration = async (dir: string, plan: ReturnType<typeof readTuneMigration>) => {
  const version = readJson<{ engine: string }>(join(dir, 'tune.json'))!.engine;
  for (const { diff, ...v } of plan.pending) await writeVariantRun(dir, version, v, diff);
  for (const { diff, evals, ...s } of plan.steps) {
    await writeVariantRun(dir, version, s, diff);
    await writeVariantDecision(dir, version, { ...s, evals: evals.filter(e => e.split !== 'test') });
    for (const e of evals.filter(e => e.split === 'test')) await writeVariantTest(dir, version, s.id, e);
  }
  for (const a of plan.attempts) {
    const file = join(dir, 'attempts', a, 'input.json');
    writeFileAtomic(file, renameCand(readJson<Labelled>(file)!));
  }
  const data = join(dir, 'data');
  for (const { run, cand, iteration } of plan.runs) {
    const origin = getRunOrigin(run.meta);
    const input = renameCand(origin?.input as Labelled);
    rmSync(join(data, run.id, 'run.json.zst'), { force: true });
    writeFileAtomic(join(data, run.id, 'run.json'), {
      ...run,
      meta: { ...run.meta, engine: { ...(run.meta?.engine as object), origin: { ...origin, input } } },
    } satisfies RunRecord);
    await Effect.runPromise(
      writeRunLabels(data, run.id, {
        ...('cand' in readRunLabels(data, run.id) && { cand: null }),
        variant: cand,
        tune: getTuneLabel(dir),
        iteration: String(iteration),
      })
    );
  }
  for (const ref of plan.refs) {
    git(dir, ['update-ref', ref.replace('refs/cand/', 'refs/variant/'), ref]);
    git(dir, ['update-ref', '-d', ref]);
  }
  for (const name of ['iterations.jsonl', 'phase.json'])
    if (existsSync(join(dir, name))) renameSync(join(dir, name), join(dir, `${name}.migrated`));
};

if (import.meta.main) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { dry: { type: 'boolean' } } });
  if (!positionals.length) {
    console.error('usage: node tune/migrate.ts <tune>... [--dry]');
    process.exit(2);
  }
  for (const dir of positionals.map(p => resolve(p))) {
    const plan = readTuneMigration(dir);
    console.log(
      `${dir}: ${plan.steps.length} decided and ${plan.pending.length} pending variants into control runs, ${plan.runs.length} runs and ${plan.attempts.length} attempts relabelled, ${plan.refs.length} refs`
    );
    for (const p of plan.problems) console.log(`  ${p}`);
    if (plan.problems.length) process.exitCode = 1;
    else if (!values.dry) await writeTuneMigration(dir, plan);
  }
}
