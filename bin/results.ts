import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Graph } from '../src/folder.ts';
import { sum } from '../src/stats.ts';
import { type CheckEntry, findLatestChecks, type Trace } from '../src/trace.ts';
import type { Run } from '../src/workflow.ts';
import {
  benchFields,
  type CheckField,
  findCheckFields,
  readBenchRowResults,
  type ResultSource,
  type RunResults,
} from '../studio/src/results/result.ts';
import { readBenchRows } from './bench.ts';
import { readFileOrEmpty, readJsonl } from './resume.ts';
import { type Step, tunesOf } from './tune.ts';

const findDeadReason = (run: Run, trace: Trace[]) =>
  run.status === 'done' || run.status === 'stopped'
    ? trace.some(t => ('event' in t && t.event.type === 'start') || ('outcome' in t && t.outcome.kind === 'pass'))
      ? undefined
      : 'ended before any step passed or any session started'
    : undefined;

const readRuns = (data: string, graph?: Pick<Graph, 'checks'>): RunResults[] => {
  const versions = Object.fromEntries(Object.entries(graph?.checks ?? {}).map(([name, c]) => [name, c.version]));
  return (existsSync(data) ? readdirSync(data) : []).flatMap(id => {
    const json = readFileOrEmpty(join(data, id, 'run.json'));
    if (!json) return [];
    const run = JSON.parse(json) as Run;
    const dead = findDeadReason(run, readJsonl<Trace>(join(data, id, 'trace.jsonl')));
    const latest = findLatestChecks(readJsonl<CheckEntry>(join(data, id, 'checks.jsonl')), versions);
    return [
      {
        key: id,
        at: run.started,
        href: `/runs/${encodeURIComponent(id)}`,
        ...(dead && { dead }),
        axes: { issue: `#${run.issue}`, workflow: run.workflow, status: run.status },
        results: Object.fromEntries(
          latest.map(e => [
            e.check.check,
            {
              at: e.at,
              pass: e.check.pass,
              ...(e.check.value && { value: e.check.value }),
              ...(e.check.share !== undefined && { share: e.check.share }),
              ...(e.check.empty && { empty: e.check.empty }),
              ...(e.later && { later: e.later }),
              ...('older' in e && { older: true as const }),
            },
          ])
        ),
      },
    ];
  });
};

const weighted = (step: Step, of: (e: Step['evals'][number]) => number) => {
  const evals = step.evals.filter(e => e.split === 'fit' || e.split === 'validate');
  const n = sum(evals.map(e => e.cases.length));
  return n ? sum(evals.map(e => of(e) * e.cases.length)) / n : undefined;
};

const tuneFields: CheckField[] = [
  { check: 'tune', field: 'quality', type: 'number', description: 'select quality, human = 1', limit: { maximum: 1 } },
  { check: 'tune', field: 'usd', type: 'number', unit: 'usd', description: 'list price per run, mean over cases' },
  { check: 'tune', field: 'minutes', type: 'number', unit: 'minutes', description: 'minutes per run, mean over cases' },
];

const readTunes = (root?: string) =>
  tunesOf(root).flatMap(({ name, tune: { repo }, steps }) =>
    steps.map((step): RunResults & { step: Step } => {
      const perRun = (k: 'usd' | 'minutes') => weighted(step, e => e.perRun?.[k] ?? e[k] / Math.max(1, e.cases.length));
      const value = Object.fromEntries(
        Object.entries({
          quality: weighted(step, e => e.quality),
          usd: perRun('usd'),
          minutes: perRun('minutes'),
        }).filter(([, v]) => v !== undefined)
      );
      return {
        key: `${repo}/${name}/${step.id}`,
        at: step.at,
        href: `/results?from=tune&pick=${encodeURIComponent(`${repo}/${name}/${step.id}`)}`,
        ...(step.verdict === 'infra' && { dead: step.why || 'infra' }),
        axes: {
          tune: `${repo}/${name}`,
          repo,
          iteration: String(step.iteration),
          candidate: step.id,
          verdict: step.verdict,
          proposer: step.proposer,
        },
        results: { tune: { at: step.at, pass: step.verdict === 'kept', value } },
        step,
      };
    })
  );

export const readRunResults = (
  from: ResultSource,
  dirs: { data?: string; bench?: string[]; benchOuts?: (dir: string) => string[]; tune?: string },
  graph?: Pick<Graph, 'checks'>
) => {
  const runs =
    from === 'runs'
      ? readRuns(dirs.data ?? '', graph)
      : from === 'tune'
        ? readTunes(dirs.tune)
        : (dirs.bench ?? [])
            .flatMap(dir => dirs.benchOuts?.(dir) ?? [dir])
            .flatMap(out => readBenchRows(out))
            .filter(row => !/\/(human|floor)@/.test(row.point))
            .map(row => readBenchRowResults(row));
  const fixed = from === 'bench' ? benchFields : from === 'tune' ? tuneFields : [];
  const found = findCheckFields(runs, graph?.checks).filter(f => !fixed.some(x => x.check === f.check));
  return { fields: [...found, ...fixed], runs };
};
