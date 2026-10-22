import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { change, runScript } from './kit.ts';

const script = resolve(import.meta.dirname, '../examples/agentgraph/scripts/transitions.mjs');
const items = (repo: { dir: string; base: string }) => {
  const { ok, out } = runScript(script, repo);
  expect(ok).toBe(true);
  return out ? out.split('\n').map(line => JSON.parse(line) as Record<string, string>) : [];
};

const declared = {
  'src/workflow.ts': "export type Run = {\n  status: 'queued' | 'running' | 'failed';\n};\n",
};
const jobs = (status: string) =>
  `export const step = (left: number) => {\n  if (left > 0) return 'more';\n  return ${status};\n};\n`;

describe('transitions', () => {
  it('emits one item per status value the change names, with the code around it', () => {
    const repo = change(
      { ...declared, 'src/jobs.ts': jobs("'running'") },
      {
        'src/jobs.ts': jobs("'failed'"),
        'studio/src/badge.ts': "export const live = (s: string) => s === 'running';\n",
      }
    );
    const found = items(repo);
    expect(found.map(i => i['run status'])).toEqual(['running', 'failed']);
    expect(found[0]!.transitions).toContain("+export const live = (s: string) => s === 'running';");
    expect(found[0]!.transitions).toContain("-  return 'running';");
    expect(found[1]!.transitions).toContain("+  return 'failed';");
  });

  it('emits nothing when the change names no status value', () => {
    const repo = change(
      { ...declared, 'src/jobs.ts': jobs("'running'") },
      { 'src/jobs.ts': jobs("'running'").replace('left > 0', 'left >= 1'), 'docs.md': "'failed'\n" }
    );
    expect(items(repo)).toEqual([]);
  });
});
