import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Graph } from '../src/folder.ts';
import { sum } from '../src/stats.ts';
import { type CheckEntry, findLatestChecks, type Trace } from '../src/trace.ts';
import type { RunRecord } from '../src/workflow.ts';
import { getRunOrigin } from '../src/meta.ts';
import { Effect, Schema } from 'effect';
import { readConfiguredGraph } from '../src/harnesses.ts';
import { findCheckFields, ResultSheet } from '../src/results.ts';
import { readResultSheets, writeResultSheet } from '../src/store.ts';
import {
  benchFields,
  type CheckField,
  readBenchRowResults,
  type ResultSource,
  type RunResults,
} from '../studio/src/results/result.ts';
import { readBenchRows } from './bench.ts';
import { readFileOrEmpty, readJsonl } from './resume.ts';
import { type Step, tunesOf } from './tune.ts';

const findDeadReason = (run: RunRecord, trace: Trace[]) =>
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
    const run = JSON.parse(json) as RunRecord;
    const origin = getRunOrigin(run.meta);
    const trace = readJsonl<Trace>(join(data, id, 'trace.jsonl'));
    const dead = findDeadReason(run, trace);
    const started = trace.flatMap(line => ('event' in line && line.event.type === 'start' ? [line.event] : []));
    const dimensions = (key: 'model' | 'harness') =>
      [...new Set(started.map(event => event[key]).filter(Boolean))].toSorted().join(', ');
    const latest = findLatestChecks(readJsonl<CheckEntry>(join(data, id, 'checks.jsonl')), versions);
    return [
      {
        key: id,
        at: run.started,
        href: `/runs/${encodeURIComponent(id)}`,
        ...(dead && { dead }),
        axes: {
          ...(run.issue !== undefined && { issue: `#${run.issue}` }),
          workflow: run.workflow,
          status: run.status,
          ...(run.graph && { graph: run.graph }),
          ...(dimensions('model') && { model: dimensions('model') }),
          ...(dimensions('harness') && { harness: dimensions('harness') }),
          ...(origin && { plugin: origin.plugin, job: origin.job }),
        },
        ...(run.meta && { meta: run.meta }),
        results: Object.fromEntries(
          latest.map(e => [
            e.check.check,
            {
              at: e.at,
              pass: e.check.pass,
              ...(e.check.value && { value: e.check.value }),
              ...(e.check.share !== undefined && { share: e.check.share }),
              ...(e.check.empty && { empty: e.check.empty }),
              ...(e.check.na && { na: e.check.na }),
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
  from: ResultSource | 'bench',
  dirs: { data?: string; bench?: string[]; tune?: string },
  graph?: Pick<Graph, 'checks'>
) => {
  if (from === 'exports') {
    const roots = [
      ...(dirs.data ? [join(dirs.data, 'plugins')] : []),
      ...(dirs.bench ?? []),
      ...(dirs.tune ? [dirs.tune] : []),
    ];
    const sheets = readResultSheets(roots);
    const fields = new Map<string, CheckField>();
    for (const { sheet } of sheets)
      for (const field of sheet.fields) {
        const key = JSON.stringify([field.check, field.field]);
        const before = fields.get(key);
        if (before && !isDeepStrictEqual(before, field))
          throw new Error(`conflicting result field ${field.check}/${field.field}`);
        fields.set(key, field);
      }
    return {
      fields: [...fields.values()],
      runs: sheets.flatMap(({ key, sheet }) =>
        sheet.runs.map(row => ({ ...row, key: `${key}:${row.key}`, axes: { ...row.axes, export: key } }))
      ),
    };
  }

  const runs =
    from === 'runs'
      ? readRuns(dirs.data ?? '', graph)
      : from === 'tune'
        ? readTunes(dirs.tune)
        : (dirs.bench ?? []).flatMap(out => readBenchRows(out)).map(row => readBenchRowResults(row));
  const fixed = from === 'bench' ? benchFields : from === 'tune' ? tuneFields : [];
  const found = findCheckFields(runs, graph?.checks).filter(f => !fixed.some(x => x.check === f.check));
  return { fields: [...found, ...fixed], runs };
};

if (import.meta.main) {
  const [from, source, output, graphDir] = process.argv.slice(2);
  if ((from !== 'runs' && from !== 'bench' && from !== 'tune') || !source || !output)
    throw new Error('usage: node bin/results.ts runs|bench|tune <source> <output> [graph]');
  const dirs = from === 'runs' ? { data: source } : from === 'bench' ? { bench: [source] } : { tune: source };
  const graph = graphDir ? await Effect.runPromise(readConfiguredGraph(graphDir)) : undefined;
  const sheet = Schema.decodeUnknownSync(ResultSheet)(readRunResults(from, dirs, graph));
  const qualify = (check: string) => (from !== 'runs' && check === from ? `${from}/score` : `engine/${check}`);
  writeResultSheet(output, {
    fields: sheet.fields.map(field => ({ ...field, check: qualify(field.check) })),
    runs: sheet.runs.map(row => ({
      ...row,
      results: Object.fromEntries(Object.entries(row.results).map(([check, result]) => [qualify(check), result])),
    })),
  });
}
