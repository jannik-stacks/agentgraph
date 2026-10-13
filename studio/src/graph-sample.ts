import type { GraphEdge, GraphModel, GraphNode } from './graph-model.ts';

const node = (
  id: string,
  kind: GraphNode['kind'],
  label: string,
  extra: Omit<GraphNode, 'id' | 'kind' | 'label'> = {}
) => ({
  id,
  kind,
  label,
  ...extra,
});
const edge = (from: string, to: string, kind: GraphEdge['kind'], label?: string): GraphEdge => ({
  from,
  to,
  kind,
  ...(label && { label }),
});

/** An issue-to-pull-request workflow that uses every node and edge kind. */
export const sampleModel: GraphModel = {
  nodes: [
    node('t:command', 'trigger', '/bothub', { detail: { summary: 'issue_comment' } }),
    node('j:implement', 'job', 'implement', {
      badges: [{ text: 'warn', tone: 'warn' }],
      detail: { summary: 'until types, tests, hunk-review pass' },
    }),
    node('j:chunk', 'script', 'hunks', {
      badges: [{ text: 'block', tone: 'danger' }],
      detail: { summary: 'one item per diff hunk' },
    }),
    node('c:types', 'check', 'types', {
      badges: [{ text: 'block', tone: 'danger' }],
      detail: { summary: 'tsc --noEmit' },
    }),
    node('c:tests', 'check', 'tests', {
      badges: [{ text: 'block', tone: 'danger' }],
      detail: { summary: 'vitest run' },
    }),
    node('c:chunk-review', 'check', 'hunk-review', {
      badges: [{ text: 'warn', tone: 'warn' }],
      detail: { summary: 'reviewer on each hunk' },
    }),
    node('j:open-pr', 'job', 'open-pr', {
      badges: [{ text: 'block', tone: 'danger' }],
      detail: { summary: 'open-pr, reply' },
    }),
    node('b:implementor', 'bot', 'implementor', {
      badges: [{ text: 'opencode', tone: 'info' }, { text: 'smart' }],
      detail: { summary: 'can: reply, push, open-pr' },
    }),
    node('b:reviewer', 'bot', 'reviewer', {
      badges: [{ text: 'pi', tone: 'info' }],
      detail: { summary: 'can: reply' },
    }),
    node('s:implement', 'skill', 'implement', { detail: { summary: 'forced' } }),
    node('s:review-chunk', 'skill', 'review-hunk', { detail: { summary: 'forced' } }),
    node('n:decision', 'note', 'decisions', { detail: { summary: 'notes/decision' } }),
    node('n:convention', 'note', 'conventions', { detail: { summary: 'notes/convention' } }),
  ],
  edges: [
    edge('t:command', 'j:implement', 'triggers'),
    edge('j:implement', 'b:implementor', 'runs-as'),
    edge('j:implement', 's:implement', 'uses-skill'),
    edge('j:implement', 'c:types', 'needs'),
    edge('j:implement', 'c:tests', 'needs'),
    edge('j:implement', 'j:chunk', 'needs'),
    edge('j:chunk', 'c:chunk-review', 'fans-out'),
    edge('c:chunk-review', 'b:reviewer', 'runs-as'),
    edge('c:chunk-review', 's:review-chunk', 'uses-skill'),
    edge('c:types', 'j:open-pr', 'gates'),
    edge('c:tests', 'j:open-pr', 'gates'),
    edge('c:chunk-review', 'j:open-pr', 'gates'),
    edge('c:chunk-review', 'j:implement', 'loops-back', 'retry with findings, max 3'),
    edge('n:decision', 'b:implementor', 'reads-notes'),
    edge('n:convention', 'b:implementor', 'reads-notes'),
  ],
};
