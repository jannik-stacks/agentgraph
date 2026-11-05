import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Effect } from 'effect';
import { writeRunLabels } from '../src/labels.ts';
import { getRunOrigin } from '../src/meta.ts';
import { startRun } from '../src/run/start.ts';
import { getRounded, sum } from '../src/stats.ts';
import { fileStore, readJsonlRows, readRecordSync, Store } from '../src/store.ts';
import type { CheckEntry } from '../src/trace.ts';
import type { CheckResult, RunRecord } from '../src/workflow.ts';

export type Split = 'mine' | 'fit' | 'validate' | 'test';
export type Flip = 'up' | 'down' | 'win' | 'loss';
export type Eval = {
  variant: string;
  split: Split;
  cases: string[];
  quality: number;
  ci: [number, number];
  delta?: number;
  pUp?: number;
  flips?: Record<string, Flip>;
  usd: number;
  minutes: number;
  perRun?: { usd: number; minutes: number };
  saved?: Record<'usd' | 'minutes', { share: number; pDown: number }>;
  codex: number;
  claude5h: number;
};
export type Variant = {
  id: string;
  iteration: number;
  parent: string;
  base: string;
  graph: string;
  proposer: 'retro' | 'history' | 'manual' | 'skill' | 'structure';
  rationale: string;
};
export type TuneStep = Variant & {
  evals: Eval[];
  verdict: 'kept' | 'discarded' | 'screened-out' | 'infra';
  why: string;
  at: string;
};

export const getTuneLabel = (dir: string) => `${basename(dirname(dir))}/${basename(dir)}`;

const runId = (variant: string) => `tune-${variant}`;

const inStore = <A>(dir: string, effect: Effect.Effect<A, unknown, Store>) =>
  Effect.runPromise(effect.pipe(Effect.provide(fileStore(join(dir, 'data')))));

const addCheck = (
  dir: string,
  id: string,
  version: string,
  step: string,
  check: Omit<CheckResult, 'ms'>,
  at = new Date().toISOString()
) =>
  inStore(
    dir,
    Effect.flatMap(Store, store =>
      store.addChecks(runId(id), {
        at,
        step,
        check: { ...check, ms: 0 },
        version,
        usd: 0,
      })
    )
  );

export const writeVariantRun = async (dir: string, version: string, v: Variant, diff: string) => {
  const id = runId(v.id);
  const tune = getTuneLabel(dir);
  const run: RunRecord = {
    id,
    workflow: 'tune',
    step: 'evaluate',
    status: 'running',
    tries: 0,
    rounds: {},
    sessions: {},
    title: `${v.id}, ${v.proposer}`,
    body: v.rationale,
    started: new Date().toISOString(),
    meta: {
      engine: {
        origin: {
          plugin: 'tune',
          version,
          job: tune,
          input: {
            variant: v.id,
            iteration: v.iteration,
            parent: v.parent,
            base: v.base,
            graph: v.graph,
            proposer: v.proposer,
          },
        },
      },
    },
  };
  if (!(await inStore(dir, startRun(run)))) return;
  await Effect.runPromise(
    writeRunLabels(join(dir, 'data'), id, {
      tune,
      iteration: String(v.iteration),
      variant: v.id,
      proposer: v.proposer,
    })
  );
  await addCheck(dir, v.id, version, 'propose', {
    check: 'tune/proposal',
    pass: true,
    value: { parent: v.parent, graph: v.graph },
    findings: diff ? `${v.rationale}\n\n${diff}` : v.rationale,
  });
};

const weighted = (evals: Eval[], of: (e: Eval) => number) => {
  const select = evals.filter(e => e.split === 'fit' || e.split === 'validate');
  const n = sum(select.map(e => e.cases.length));
  return n ? getRounded(sum(select.map(e => of(e) * e.cases.length)) / n) : undefined;
};

export const writeVariantDecision = async (dir: string, version: string, s: TuneStep) => {
  const perRun = (k: 'usd' | 'minutes') => weighted(s.evals, e => e.perRun?.[k] ?? e[k] / Math.max(1, e.cases.length));
  const value = Object.fromEntries(
    Object.entries({
      verdict: s.verdict,
      why: s.why,
      quality: weighted(s.evals, e => e.quality),
      usd: perRun('usd'),
      minutes: perRun('minutes'),
      evals: s.evals,
    }).filter(([, v]) => v !== undefined)
  );
  await addCheck(
    dir,
    s.id,
    version,
    'decide',
    {
      check: 'tune/decision',
      pass: s.verdict === 'kept',
      value,
      findings: s.why,
    },
    s.at
  );
  await Effect.runPromise(writeRunLabels(join(dir, 'data'), runId(s.id), { verdict: s.verdict }));
  await inStore(
    dir,
    Effect.gen(function* () {
      const store = yield* Store;
      const run = yield* store.getRecord(runId(s.id));
      if (run) yield* store.put({ ...run, step: 'decided', status: 'done', ended: s.at });
    })
  );
};

export const writeVariantTest = (dir: string, version: string, id: string, e: Eval) =>
  addCheck(dir, id, version, 'checkpoint', { check: 'tune/test', pass: true, value: e });

export const readTuneSteps = (dir: string) => {
  const data = join(dir, 'data');
  const found = (existsSync(data) ? readdirSync(data) : []).flatMap(id => {
    if (!id.startsWith('tune-')) return [];
    const json = readRecordSync(join(data, id, 'run.json'));
    const run = json ? (JSON.parse(json) as RunRecord) : undefined;
    const origin = run && getRunOrigin(run.meta);
    if (!run || run.workflow !== 'tune' || origin?.plugin !== 'tune') return [];
    const { variant, ...input } = origin.input as Omit<Variant, 'id' | 'rationale'> & { variant: string };
    const v: Variant = { id: variant, ...input, rationale: run.body ?? '' };
    const checks = readJsonlRows(join(data, id, 'checks.jsonl')) as CheckEntry[];
    const decided = checks.findLast(e => e.check.check === 'tune/decision');
    const tests = checks.flatMap(e => (e.check.check === 'tune/test' ? [e.check.value as Eval] : []));
    const d = decided?.check.value as Pick<TuneStep, 'verdict' | 'why' | 'evals'> | undefined;
    return [
      {
        v,
        ...(d && { step: { ...v, verdict: d.verdict, why: d.why, evals: [...d.evals, ...tests], at: decided!.at } }),
      },
    ];
  });
  return {
    steps: found
      .flatMap(f => (f.step ? [f.step] : []))
      .toSorted((a, b) => a.iteration - b.iteration || a.at.localeCompare(b.at) || a.id.localeCompare(b.id)),
    pending: found.flatMap(f => (f.step ? [] : [f.v])).toSorted((a, b) => a.id.localeCompare(b.id)),
  };
};
