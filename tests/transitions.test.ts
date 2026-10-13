import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { change, runScript } from './kit.ts';

const script = resolve(import.meta.dirname, '../examples/bothub/scripts/transitions.mjs');
const items = (repo: { dir: string; base: string }) => {
  const { ok, out } = runScript(script, repo);
  expect(ok).toBe(true);
  return out ? out.split('\n').map(line => JSON.parse(line) as Record<string, string>) : [];
};

const declared = {
  'src/store.ts': "export type RunStatus =\n  | 'queued'\n  | 'running'\n  | 'failed';\n",
  'src/schema.ts': "export const Closure = z.enum(['done', 'blocked']);\n",
};
const close = (closure: string) =>
  `export const close = (left: number) => {\n  if (left > 0) return 'more';\n  return ${closure};\n};\n`;

describe('transitions', () => {
  it('emits one item per status or closure value the change names, with the code around it', () => {
    const repo = change(
      { ...declared, 'src/jobs.ts': close("'done'") },
      {
        'src/jobs.ts': close("'blocked'"),
        'studio/src/badge.ts': "export const live = (s: string) => s === 'running';\n",
      }
    );
    expect(items(repo)).toEqual([
      {
        'run status': 'running',
        transitions: expect.stringContaining("+export const live = (s: string) => s === 'running';"),
      },
      { closure: 'done', transitions: expect.stringContaining("-  return 'done';") },
      { closure: 'blocked', transitions: expect.stringContaining("+  return 'blocked';") },
    ]);
    expect(items(repo)[2]!.transitions).toContain("   if (left > 0) return 'more';");
  });

  it('emits nothing when the change names no status or closure value', () => {
    const repo = change(
      { ...declared, 'src/jobs.ts': close("'done'") },
      { 'src/jobs.ts': close("'done'").replace('left > 0', 'left >= 1'), 'docs.md': "'failed'\n" }
    );
    expect(items(repo)).toEqual([]);
  });
});
