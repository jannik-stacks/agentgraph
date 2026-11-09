import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Graph } from '../src/folder.ts';
import { findLatestChecks } from '../src/trace.ts';
import { isOnIssue } from '../src/graph.ts';
import { getRunOrigin } from '../src/meta.ts';
import { findCheckFields } from '../src/results.ts';
import { makeVersionLabels, readRunLabels } from '../src/labels.ts';
import type { RunResults } from '../studio/src/results/result.ts';
import { readFileOrEmpty, readJsonl } from './resume.ts';
import { type CheckEntry, type RunRecord, type Trace } from '../src/types.ts';

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
    const dead = isOnIssue(run) ? findDeadReason(run, trace) : undefined;
    const started = trace.flatMap(line => ('event' in line && line.event.type === 'start' ? [line.event] : []));
    const reported = trace.flatMap(line =>
      'event' in line && line.event.type === 'usage' && line.event.model ? [line.event.model] : []
    );
    const dimensions = (values: string[]) => [...new Set(values.filter(Boolean))].toSorted().join(', ');
    const model = dimensions(started.map(event => event.model));
    const harness = dimensions(started.map(event => event.harness));
    const latest = findLatestChecks(readJsonl<CheckEntry>(join(data, id, 'checks.jsonl')), versions);
    return [
      {
        key: id,
        at: run.started,
        href: `/runs/${encodeURIComponent(id)}`,
        ...(dead && { dead }),
        axes: {
          ...makeVersionLabels(run.versions),
          ...readRunLabels(data, id),
          ...(run.issue !== undefined && { issue: `#${run.issue}` }),
          workflow: run.workflow,
          status: run.status,
          ...(run.graph && { graph: run.graph }),
          ...(model && { model }),
          ...(reported.length > 0 && { 'harness-model': dimensions(reported) }),
          ...(harness && { harness }),
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

export const readRunResults = (data: string | undefined, graph?: Pick<Graph, 'checks'>) => {
  const runs = data ? readRuns(data, graph) : [];
  return { fields: findCheckFields(runs, graph?.checks), runs };
};
