import type { Graph } from '../src/folder.ts';
import { readStoredRuns } from '../src/engine.ts';
import { isOnIssue } from '../src/graph.ts';
import { getRunOrigin } from '../src/meta.ts';
import { findCheckFields, sumHumanInteractions } from '../src/results.ts';
import { makeVersionLabels } from '../src/labels.ts';
import type { RunResults } from '../studio/src/results/result.ts';
import { readTraceSync } from '../src/store.ts';
import { type RunRecord, type Trace } from '../src/types.ts';

const findDeadReason = (run: RunRecord, trace: Trace[]) =>
  run.status === 'done' || run.status === 'stopped'
    ? trace.some(t => ('event' in t && t.event.type === 'start') || ('outcome' in t && t.outcome.kind === 'pass'))
      ? undefined
      : 'ended before any step passed or any session started'
    : undefined;

const humans = {
  mode: 'info',
  returns: {
    properties: {
      coverage: { type: 'string', description: 'complete when the run recorded what it heard from its start' },
      comments: { type: 'integer', description: 'comments people wrote during the run' },
      reviews: { type: 'integer', description: 'reviews people submitted during the run' },
      labels: { type: 'integer', description: 'labels people added or removed during the run' },
      requests: { type: 'integer', description: 'reviews people asked for during the run' },
      waitSeconds: { type: 'number', unit: 'seconds', description: 'time the run waited for a person' },
      openWaitSeconds: {
        type: 'number',
        unit: 'seconds',
        description: 'time it has waited so far, while it still waits',
      },
    },
  },
} as const;

const readRuns = (data: string, graph?: Pick<Graph, 'checks'>): RunResults[] =>
  readStoredRuns({ data, checks: graph?.checks }).map(({ run, labels, latest }) => {
    const id = run.id;
    const origin = getRunOrigin(run.meta);
    const trace = readTraceSync(data, id);
    const dead = isOnIssue(run) ? findDeadReason(run, trace) : undefined;
    const started = trace.flatMap(line => ('event' in line && line.event.type === 'start' ? [line.event] : []));
    const dimensions = (key: 'model' | 'harness') =>
      [...new Set(started.map(event => event[key]).filter(Boolean))].toSorted().join(', ');
    const heard = sumHumanInteractions([{ run, trace }], new Date().toISOString());
    return {
      key: id,
      at: run.started,
      href: `/runs/${encodeURIComponent(id)}`,
      ...(dead && { dead }),
      axes: {
        ...makeVersionLabels(run.versions),
        ...labels,
        ...(run.issue !== undefined && { issue: `#${run.issue}` }),
        workflow: run.workflow,
        status: run.status,
        ...(run.graph && { graph: run.graph }),
        ...(dimensions('model') && { model: dimensions('model') }),
        ...(dimensions('harness') && { harness: dimensions('harness') }),
        ...(origin && { plugin: origin.plugin, job: origin.job }),
      },
      ...(run.meta && { meta: run.meta }),
      results: Object.fromEntries([
        [
          'humans',
          {
            at: run.ended ?? run.started,
            pass: true,
            value: heard,
            ...(heard.coverage !== 'complete' && { empty: true as const }),
          },
        ],
        ...latest.map(e => [
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
        ]),
      ]),
    };
  });

export const readRunResults = (data: string | undefined, graph?: Pick<Graph, 'checks'>) => {
  const runs = data ? readRuns(data, graph) : [];
  return { fields: findCheckFields(runs, { humans, ...graph?.checks }), runs };
};
