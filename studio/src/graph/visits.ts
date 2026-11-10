import type { WorkflowGraph } from '../../../src/graph.ts';
import { getStepDoerKind } from './chips.ts';
import { makeTrailOutcome, type RunDrawnOnWorkflow, type Trail } from './scenarios.ts';
import { formatReason, type CheckEntry, type Trace } from '../../../src/types.ts';

/** Rebuilds a real run's trail from the outcome lines of its trace, each with the run as it stood before. */
export const makeRunTrail = (trace: (Trace | CheckEntry)[]): Trail => {
  let before: Omit<Trail[number]['at'], 'step'> = { status: 'running', tries: 0, rounds: {} };
  return trace.flatMap(line => {
    if (!('outcome' in line)) return [];
    const at = { ...before, step: line.step };
    before = line.run;
    return [{ at, outcome: makeTrailOutcome(line.outcome, line.run) }];
  });
};

type Node = WorkflowGraph['nodes'][number];

/** One time a run is at a step: the failed tries, and how it left. */
type Visit = {
  node: Node;
  failed: number[];
  outOfRounds?: boolean;
  left?: 'pass' | 'back' | 'stop';
  to?: string;
};

/** Where the run stands after its last visit. */
export type End =
  | { kind: 'done' }
  | { kind: 'stopped'; why: string }
  | { kind: 'asking'; why: string }
  | { kind: 'waiting' }
  | { kind: 'running'; try: number };

const isAgent = (n: Node) => getStepDoerKind(n.doer) === 'agent';

/** Unrolls a run into the visits it made, in order, leaving out steps missing from the graph. */
export function makeWorkflowRunVisits(
  graph: WorkflowGraph,
  trail: Trail,
  run: RunDrawnOnWorkflow['run']
): { visits: Visit[]; end: End; missing: string[] } {
  const find = (step: string) => graph.nodes.find(n => n.step === step);
  const missing = [...new Set([...trail.map(entry => entry.at.step), run.step].filter(step => !find(step)))];
  const visits: Visit[] = [];
  let here: Visit | undefined;
  let open = false;
  const enter = (step: string) => {
    const node = find(step);
    here = node && { node, failed: [] };
    if (here) visits.push(here);
    open = true;
  };

  trail.forEach((entry, i) => {
    const step = entry.at.step;
    if (!open) enter(step);
    const o = entry.outcome;
    if (o.kind === 'failed') here?.failed.push(o.failed);
    else if (o.kind === 'back' && 'outOfRounds' in o) {
      if (here) here.outOfRounds = true;
    } else if (o.kind === 'pass' || o.kind === 'back' || o.kind === 'stop') {
      open = false;
      if (!here) return;
      here.left = o.kind;
      if (o.kind === 'back') here.to = trail[i + 1]?.at.step ?? run.step;
    }
  });
  if (run.status !== 'done' && run.status !== 'stopped' && !open) enter(run.step);

  const why = formatReason(run);
  const end: End =
    run.status === 'done'
      ? { kind: 'done' }
      : run.status === 'stopped'
        ? { kind: 'stopped', why: run.reason ?? '' }
        : run.status === 'waiting' && why !== undefined
          ? { kind: 'asking', why }
          : run.status === 'waiting'
            ? { kind: 'waiting' }
            : { kind: 'running', try: run.tries + 1 };
  return { visits, end, missing };
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
export function makeRunStory({ visits, end, missing = [] }: { visits: Visit[]; end: End; missing?: string[] }): string {
  const groups = visits.map((v, i): string[] => {
    const step = v.node.step;
    const failed = v.failed.length > 0 ? [`${step} failed its checks ${times(v.failed.length)}`] : [];
    const isLast = i === visits.length - 1;
    if (v.left === 'pass') return [...failed, failed.length ? 'then passed' : `${step} passed`];
    if (v.left === 'back') {
      return [
        ...failed,
        `${isAgent(v.node) ? v.node.doer.split(' / ')[0] : step} sent it back${v.to ? ` to ${v.to}` : ''}`,
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
  const gone = missing.length
    ? [
        `${missing.length === 1 ? 'Step' : 'Steps'} ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in the current graph.`,
      ]
    : [];
  return [...(text ? [text.charAt(0).toUpperCase() + text.slice(1) + '.'] : []), ...gone].join(' ') || '.';
}
