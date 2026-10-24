import type { Graph } from '../../../src/graph.ts';
import type { Trace } from '../../../src/trace.ts';
import type { Run } from '../../../src/workflow.ts';
import { getStepDoerKind } from './chips.ts';
import type { Trail } from './scenarios.ts';

/** Rebuilds a real run's trail from the outcome lines of its trace, each with the run as it stood before. */
export const makeRunTrail = (run: Run, trace: Trace[]): Trail => {
  let before: Pick<Run, 'status' | 'tries' | 'rounds'> = { status: 'running', tries: 0, rounds: {} };
  return trace.flatMap(line => {
    if (!('outcome' in line)) return [];
    const at = { ...run, ...before, step: line.step };
    before = line.run;
    return [{ at, outcome: line.outcome }];
  });
};

type Node = Graph['nodes'][number];

/** One time a run is at a step: how it got there, the failed tries, and how it left. */
type Visit = {
  node: Node;
  nth: number;
  session?: 'fresh' | 'resumed';
  via?: { from: string; round: number; of?: number; why: string };
  failed: number[];
  answered: number;
  outOfRounds?: boolean;
  left?: 'pass' | 'back' | 'stop';
};

/** Where the run stands after its last visit. */
export type End =
  | { kind: 'done' }
  | { kind: 'stopped'; why: string }
  | { kind: 'asking'; why: string }
  | { kind: 'waiting' }
  | { kind: 'running'; try: number };

const isAgent = (n: Node) => getStepDoerKind(n.doer) === 'agent';

/** Unrolls a run into the visits it made, in order. */
export function makeWorkflowRunVisits(graph: Graph, trail: Trail, run: Run): { visits: Visit[]; end: End } {
  const node = (step: string) => graph.nodes.find(n => n.step === step)!;
  const visits: Visit[] = [];
  const enter = (step: string, previous?: Trail[number]) => {
    const n = node(step);
    const back = previous?.outcome.kind === 'back' ? previous : undefined;
    const round = back ? (back.at.rounds[back.at.step] ?? 0) + 1 : 0;
    const of = back && graph.edges.find(e => e.kind === 'back' && e.from === back.at.step)?.rounds;
    visits.push({
      node: n,
      nth: visits.filter(v => v.node.step === step).length + 1,
      ...(isAgent(n) && { session: back ? 'resumed' : 'fresh' }),
      ...(back?.outcome.kind === 'back' && {
        via: { from: back.at.step, round, ...(of !== undefined && { of }), why: back.outcome.why },
      }),
      failed: [],
      answered: 0,
    });
  };

  trail.forEach((entry, i) => {
    const last = visits.at(-1);
    if (!last || last.left === 'pass' || last.left === 'back') enter(entry.at.step, trail[i - 1]);
    const visit = visits.at(-1)!;
    const o = entry.outcome;
    if (o.kind === 'failed') visit.failed.push(o.checks.length + o.proposals.length + o.problems.length);
    else if (o.kind === 'answer') visit.answered++;
    else if (o.kind === 'back' && (trail[i + 1]?.at ?? run).reason !== undefined) visit.outOfRounds = true;
    else if (o.kind === 'pass' || o.kind === 'back' || o.kind === 'stop') visit.left = o.kind;
  });
  const last = visits.at(-1);
  if (run.status !== 'done' && run.status !== 'stopped' && (!last || last.left)) enter(run.step, trail.at(-1));

  const end: End =
    run.status === 'done'
      ? { kind: 'done' }
      : run.status === 'stopped'
        ? { kind: 'stopped', why: run.reason ?? '' }
        : run.status === 'waiting' && run.reason !== undefined
          ? { kind: 'asking', why: run.reason }
          : run.status === 'waiting'
            ? { kind: 'waiting' }
            : { kind: 'running', try: run.tries + 1 };
  return { visits, end };
}

const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

/** Says a repeated stretch of visits once, with how often it came round: "reviewer sent it back 3 times". */
const collapse = (groups: string[][]): string[] => {
  const text = (from: number, len: number) =>
    groups
      .slice(from, from + len)
      .flat()
      .join(', ');
  const parts: string[] = [];
  for (let i = 0; i < groups.length;) {
    let best = { len: 1, count: 1 };
    for (let len = 1; i + 2 * len <= groups.length; len++) {
      let count = 1;
      while (i + (count + 1) * len <= groups.length && text(i + count * len, len) === text(i, len)) count++;
      if (count > 1 && count * len > best.count * best.len) best = { len, count };
    }
    const block = groups.slice(i, i + best.len).flat();
    if (best.count > 1) {
      const k = block.findLastIndex(p => p.includes('sent it back'));
      if (k >= 0) block[k] = block[k]!.replace('sent it back', `sent it back ${times(best.count)}`);
      else block.push(`${times(best.count)} over`);
    }
    parts.push(...block);
    i += best.len * best.count;
  }
  return parts;
};

/** The run told in one sentence, the way a person would say it. */
export function makeRunStory({ visits, end }: { visits: Visit[]; end: End }): string {
  const groups = visits.map((v, i): string[] => {
    const step = v.node.step;
    const failed = v.failed.length > 0 ? [`${step} failed its checks ${times(v.failed.length)}`] : [];
    const isLast = i === visits.length - 1;
    if (v.left === 'pass') return [...failed, failed.length ? 'then passed' : `${step} passed`];
    if (v.left === 'back') {
      const to = visits[i + 1]?.node.step;
      return [
        ...failed,
        `${isAgent(v.node) ? v.node.doer.split(' / ')[0] : step} sent it back${to ? ` to ${to}` : ''}`,
      ];
    }
    if (v.left === 'stop' || !isLast) return failed;
    if (end.kind === 'running')
      return [...failed, failed.length ? `now on try ${end.try} of ${v.node.tries}` : `${step} working`];
    if (end.kind === 'waiting') return [...failed, `${step} waiting for you`];
    if (v.outOfRounds) return [...failed, `${step} wanted another round but had none left`];
    return failed;
  });
  const parts = collapse(groups);
  if (end.kind === 'done') parts.push('done');
  if (end.kind === 'stopped') parts.push(`stopped, ${end.why}`);
  if (end.kind === 'asking') parts.push(`${visits.at(-1)?.node.step ?? 'the run'} is asking you`);
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1) + '.';
}
