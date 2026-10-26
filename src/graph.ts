import type { Agent, Check } from './hub.ts';
import type { Run, Step, Workflow } from './workflow.ts';

/**
 * What the studio draws: what starts the workflow, one node per step, next and back edges, and the most sessions a run
 * can take before it asks. A check names the agent that judges it; a check without one is only a script. A step
 * `dispatches` when its agent may start a workflow with `on: dispatch`, and `traces` when its agent reads the traces of
 * the runs on the issue; a check the same when its judge does. `writes` lists what its agent may write to GitHub, and
 * `model` names the model alias its agent asks for.
 */
export type WorkflowGraph = {
  trigger: string;
  nodes: {
    step: string;
    doer: string;
    checks: { name: string; mode: Check['mode']; agent?: string; traces?: true }[];
    tries: number;
    each?: string;
    dispatches?: true;
    writes?: Agent['returns'];
    model?: string;
    traces?: true;
    asides?: true;
    run?: { tries: number; current: boolean; visited: boolean };
  }[];
  edges: { from: string; to: string; kind: 'next' | 'back'; until?: string; rounds?: number; taken?: number }[];
  worst: number;
};

const github = new Set<Agent['returns'][number]>(['comment', 'push', 'pull_request', 'label', 'issue', 'merge', 'ask']);

const doer = ({ does }: Step) =>
  'agent' in does ? (does.skill ? `${does.agent} / ${does.skill}` : does.agent) : 'run' in does ? 'script' : 'human';

/** What starts a workflow, in a few words. */
const triggerOf = (w: Workflow) =>
  Object.entries(w.on)
    .map(([event, t]) =>
      event === 'issue_comment'
        ? 'a /agent comment'
        : event === 'dispatch'
          ? 'dispatched'
          : event === 'feedback'
            ? "a person's review, comment or push"
            : `${event.replace('_', ' ')}${t?.branches ? ` on ${t.branches.join(', ')}` : ''}`
    )
    .join(', ');

/** Expands a workflow into the graph the studio lays out, with a run drawn over it when given. `agents` holds what each agent returns and reads. */
export function makeWorkflowGraph(
  w: Workflow,
  checks: Record<string, Pick<Check, 'mode' | 'agent'>>,
  run?: Run,
  agents: Record<string, Pick<Agent, 'returns' | 'reads' | 'model'>> = {}
): WorkflowGraph {
  const index = (name: string) => w.steps.findIndex(s => s.name === name);
  const loops = w.steps.flatMap((s, from) =>
    s.back?.rounds !== undefined && !('wait' in s.does) ? [{ to: index(s.back.to), from, rounds: s.back.rounds }] : []
  );
  const visits = (k: number) => 1 + loops.reduce((n, l) => (l.to <= k && k <= l.from ? n + l.rounds : n), 0);
  const worst = w.steps.reduce((n, s, k) => n + ('agent' in s.does ? s.tries * visits(k) : 0), 0);

  const current = run ? index(run.step) : -1;
  const reached = run
    ? run.status === 'done'
      ? w.steps.length - 1
      : Math.max(current, ...w.steps.map((s, k) => ((run.rounds[s.name] ?? 0) > 0 ? k : -1)))
    : -1;

  const nodes: WorkflowGraph['nodes'] = w.steps.map((s, k) => ({
    step: s.name,
    doer: doer(s),
    checks: s.checks.map(name => {
      const agent = checks[name]?.agent;
      return {
        name,
        mode: checks[name]?.mode ?? 'block',
        ...(agent !== undefined && { agent }),
        ...(agent !== undefined && agents[agent]?.reads && { traces: true as const }),
      };
    }),
    tries: s.tries,
    ...(s.each !== undefined && { each: typeof s.each === 'string' ? s.each : s.each.run }),
    ...('agent' in s.does && agents[s.does.agent]?.returns.includes('run') && { dispatches: true as const }),
    ...('agent' in s.does &&
      agents[s.does.agent] && { writes: agents[s.does.agent]!.returns.filter(k => github.has(k)) }),
    ...('agent' in s.does && agents[s.does.agent]?.model !== undefined && { model: agents[s.does.agent]!.model }),
    ...('agent' in s.does && agents[s.does.agent]?.reads && { traces: true as const }),
    ...('wait' in s.does && s.back && { asides: true as const }),
    ...(run && { run: { tries: k === current ? run.tries : 0, current: k === current, visited: k <= reached } }),
  }));

  const edges: WorkflowGraph['edges'] = [
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
  return { trigger: triggerOf(w), nodes, edges, worst };
}
