import type { Check } from './check.ts';
import type { Run, Step, Workflow } from './workflow.ts';

/** What the studio draws: one node per step, next and back edges, and the most sessions a run can take before it asks. */
export type Graph = {
  nodes: {
    step: string;
    doer: string;
    checks: { name: string; mode: Check['mode'] }[];
    tries: number;
    each?: string;
    run?: { tries: number; current: boolean; visited: boolean };
  }[];
  edges: { from: string; to: string; kind: 'next' | 'back'; until?: string; rounds?: number; taken?: number }[];
  worst: number;
};

const doer = ({ does }: Step) =>
  'bot' in does ? (does.skill ? `${does.bot} / ${does.skill}` : does.bot) : 'run' in does ? 'script' : 'human';

/** Expands a workflow into the graph the studio lays out, with a run drawn over it when given. */
export function graphOf(w: Workflow, checks: Record<string, Pick<Check, 'mode'>>, run?: Run): Graph {
  const index = (name: string) => w.steps.findIndex(s => s.name === name);
  const loops = w.steps.flatMap((s, from) =>
    s.back?.rounds !== undefined && !('wait' in s.does) ? [{ to: index(s.back.to), from, rounds: s.back.rounds }] : []
  );
  const visits = (k: number) => 1 + loops.reduce((n, l) => (l.to <= k && k <= l.from ? n + l.rounds : n), 0);
  const worst = w.steps.reduce((n, s, k) => n + ('bot' in s.does ? s.tries * visits(k) : 0), 0);

  const current = run ? index(run.step) : -1;
  const reached = run
    ? run.status === 'done'
      ? w.steps.length - 1
      : Math.max(current, ...w.steps.map((s, k) => ((run.rounds[s.name] ?? 0) > 0 ? k : -1)))
    : -1;

  const nodes: Graph['nodes'] = w.steps.map((s, k) => ({
    step: s.name,
    doer: doer(s),
    checks: s.checks.map(name => ({ name, mode: checks[name]?.mode ?? 'block' })),
    tries: s.tries,
    ...(s.each !== undefined && { each: typeof s.each === 'string' ? s.each : s.each.run }),
    ...(run && { run: { tries: k === current ? run.tries : 0, current: k === current, visited: k <= reached } }),
  }));

  const edges: Graph['edges'] = [
    ...w.steps.slice(1).map((s, k) => ({ from: w.steps[k]!.name, to: s.name, kind: 'next' as const })),
    ...w.steps.flatMap(s =>
      s.back
        ? [
            {
              from: s.name,
              to: s.back.to,
              kind: 'back' as const,
              ...(s.back.until !== undefined && { until: s.back.until }),
              ...(s.back.rounds !== undefined && { rounds: s.back.rounds }),
              ...(run && { taken: run.rounds[s.name] ?? 0 }),
            },
          ]
        : []
    ),
  ];
  return { nodes, edges, worst };
}
