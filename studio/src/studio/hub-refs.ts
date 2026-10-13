import type { NodeKind } from '../graph-model.ts';

/** The node kind a field's values name, by field name. */
export const refKind: Record<string, NodeKind> = {
  bot: 'bot',
  subagents: 'bot',
  skill: 'skill',
  skills: 'skill',
  check: 'check',
  checks: 'check',
  requires: 'check',
  notes: 'note',
  tools: 'tool',
};

/** The node id a field value names, if it names one. */
export const refId = (key: string, value: string) => {
  if (key === 'preload') return value === 'issue' || value === 'links' ? 'issues:issues' : undefined;
  const kind = refKind[key];
  return kind && `${kind}:${value}`;
};

/** Fields whose values are code, paths or identifiers, shown in a monospace font. */
export const mono = new Set([
  'branch',
  'branches',
  'command',
  'cron',
  'environment',
  'into',
  'paths',
  'run',
  'source',
  'tools',
  'types',
]);

/** Where selecting a node goes: the graph with that node selected and the editor closed. */
export const nodeTarget = (id: string) => ({ path: '/studio', query: { node: id, edit: null } });
