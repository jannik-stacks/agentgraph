import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile, type Config } from '../src/config.ts';
import { readHub } from '../src/load.ts';
import { studioModule } from './studio.ts';

type Node = {
  id: string;
  kind: string;
  label: string;
  data?: Record<string, unknown>;
  stack?: { owner: string; members: string[]; facets: { key: string; counts: [string, number][] }[] };
};
type Edge = { from: string; to: string; kind: string; label?: string };
type Model = { nodes: Node[]; edges: Edge[] };
type CollapseModule = {
  fanLimit: number;
  collapse: (model: Model) => Model;
  heldBy: (model: Model) => Map<string, string>;
  fold: <T>(items: T[]) => { shown: T[]; rest: T[] };
};
type LayoutModule = { checkGroups: (model: Model) => Map<string, string[]> };
type GraphModule = {
  graphModel: (config: Config) => Model;
  layerModel: (model: Model, layer: 'flow' | 'cast') => Model;
};

const { fanLimit, collapse, heldBy, fold } = await studioModule<CollapseModule>('studio/collapse.ts');
const { checkGroups } = await studioModule<LayoutModule>('studio/layout.ts');
const { graphModel, layerModel } = await studioModule<GraphModule>('graph-model.ts');

const modes = ['shadow', 'block', 'warn', 'block', 'shadow', 'warn', 'block', 'shadow'];
const types = ['script', 'bot', 'script', 'decide', 'script', 'script', 'bot', 'script'];

const hub = (count: number): Model => {
  const checks = Array.from({ length: count }, (_, i) => ({
    id: `check:c${i}`,
    kind: 'check',
    label: `c${i}`,
    data: { mode: modes[i % modes.length], type: types[i % types.length] },
  }));
  return {
    nodes: [
      { id: 'trigger:w/push', kind: 'trigger', label: 'push' },
      { id: 'job:w/build', kind: 'job', label: 'build' },
      { id: 'job:w/ship', kind: 'job', label: 'ship' },
      ...checks,
      { id: 'bot:checker', kind: 'bot', label: 'checker' },
    ],
    edges: [
      { from: 'trigger:w/push', to: 'job:w/build', kind: 'triggers' },
      { from: 'job:w/build', to: 'job:w/ship', kind: 'needs' },
      ...checks.flatMap(c => [
        { from: c.id, to: 'job:w/build', kind: 'gates' },
        { from: c.id, to: 'job:w/build', kind: 'loops-back', label: 'max 3' },
        { from: c.id, to: 'bot:checker', kind: 'runs-as' },
      ]),
    ],
  };
};

describe('studio graph stacks', () => {
  it('keeps a group at the fan limit and folds one past it', () => {
    expect(fanLimit).toBe(5);
    expect(collapse(hub(fanLimit)).nodes.some(n => n.stack)).toBe(false);
    const folded = collapse(hub(fanLimit + 1));
    const [stack, ...others] = folded.nodes.filter(n => n.stack);
    expect(others).toEqual([]);
    expect(stack).toMatchObject({ id: 'stack:job:w/build/check', kind: 'check', label: '+2 checks' });
    expect(folded.nodes.filter(n => n.kind === 'check' && !n.stack)).toHaveLength(fanLimit - 1);
    expect(fold([1, 2, 3, 4, 5])).toEqual({ shown: [1, 2, 3, 4, 5], rest: [] });
    expect(fold([1, 2, 3, 4, 5, 6])).toEqual({ shown: [1, 2, 3, 4], rest: [5, 6] });
  });

  it('shows block checks before warn before shadow, keeping their order within a mode, and stacks the rest last', () => {
    const folded = collapse(hub(8));
    const checks = folded.nodes.filter(n => n.kind === 'check');
    expect(checks.map(n => n.id)).toEqual(['check:c1', 'check:c3', 'check:c6', 'check:c2', 'stack:job:w/build/check']);
    expect(checks.at(-1)!.stack!.members).toEqual(['check:c5', 'check:c0', 'check:c4', 'check:c7']);
    expect(checkGroups(folded).get('job:w/build')).toEqual(checks.map(n => n.id));
  });

  it('counts what the stack holds by mode and by type', () => {
    const stack = collapse(hub(8)).nodes.find(n => n.stack)!;
    expect(stack.stack!.facets).toEqual([
      {
        key: 'mode',
        counts: [
          ['warn', 1],
          ['shadow', 3],
        ],
      },
      { key: 'type', counts: [['script', 4]] },
    ]);
  });

  it('leads the held checks edges to the stack, one per kind and end', () => {
    const folded = collapse(hub(8));
    const held = heldBy(folded);
    expect(held.size).toBe(4);
    expect(folded.edges.some(e => held.has(e.from) || held.has(e.to))).toBe(false);
    const fromStack = folded.edges.filter(e => e.from === 'stack:job:w/build/check');
    expect(fromStack.map(e => `${e.kind} ${e.to} ${e.label ?? ''}`)).toEqual([
      'gates job:w/build ',
      'loops-back job:w/build max 3',
      'runs-as bot:checker ',
    ]);
    expect(folded.edges.filter(e => e.kind === 'runs-as')).toHaveLength(fanLimit);
    expect(folded.edges.filter(e => e.kind === 'triggers' || e.kind === 'needs')).toHaveLength(2);
  });

  it('folds the crowded check list of the bothub hub in both layers', async () => {
    const compiled = compile(await readHub(join(import.meta.dirname, '..', 'examples', 'bothub')));
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
    const model = graphModel(compiled.config);
    const until = compiled.config.workflows.issue!.jobs.implement!;
    const total = until.type === 'bot' ? (until.until?.checks.length ?? 0) : 0;
    expect(total).toBeGreaterThan(fanLimit);
    for (const layer of ['flow', 'cast'] as const) {
      const folded = collapse(layerModel(model, layer));
      const stack = folded.nodes.find(n => n.id === 'stack:job:issue/implement/check');
      expect(stack?.stack?.members).toHaveLength(total - (fanLimit - 1));
      expect(checkGroups(folded).get('job:issue/implement')).toHaveLength(fanLimit);
    }
  });
});
