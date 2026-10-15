import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { change, runScript } from './kit.ts';

const script = resolve(import.meta.dirname, '../examples/bothub/scripts/propagation.mjs');
const run = (repo: { dir: string; base: string }) => runScript(script, repo);

const status = (name: string) => `export type Status = 'running' | '${name}';\n`;
const docs = 'A run ends `merged` once a human merges it.\n';

describe('propagation', () => {
  it('reports the copies a renamed literal leaves in docs and hubs', () => {
    const repo = change(
      {
        'src/status.ts': status('merged'),
        'docs/runs.md': docs,
        'examples/hub/skills/land.md': "Wait for 'merged'.\n",
      },
      { 'src/status.ts': status('landed') }
    );
    expect(run(repo)).toEqual({
      ok: false,
      out: [
        'merged: the change takes it out of src/status.ts, but docs/runs.md:1, examples/hub/skills/land.md:1 still say it',
        'propagation: 1 finding',
      ].join('\n'),
    });
  });

  it('reports a removed field and a deleted check that other files still name', () => {
    const repo = change(
      {
        'src/config.ts': 'export type Config = {\n  maxAttempts: number;\n  retryLimit: number;\n};\n',
        'infra/local/hub.yaml': 'retryLimit: 3\n',
        'examples/hub/checks/old-check.md': '---\ntype: script\n---\n',
        'examples/hub/workflows/issue.md': 'checks: [old-check]\n',
      },
      { 'src/config.ts': 'export type Config = {\n  maxAttempts: number;\n};\n' },
      ['examples/hub/checks/old-check.md']
    );
    expect(run(repo).out.split('\n')).toEqual([
      'old-check: the change takes it out of examples/hub/checks/old-check.md, but examples/hub/workflows/issue.md:1 still says it',
      'retryLimit: the change takes it out of src/config.ts, but infra/local/hub.yaml:1 still says it',
      'propagation: 2 findings',
    ]);
  });

  it('passes a rename that reaches every copy, reworded prose and a dropped call', () => {
    const repo = change(
      {
        'src/status.ts': status('merged'),
        'src/use.ts': "import { helperFn } from './help.ts';\nhelperFn(1);\nhelperFn(2);\n",
        'src/help.ts': 'export const helperFn = (n: number) => n;\n',
        'docs/runs.md': docs,
        'docs/loop.md': 'The bot opens a merge request.\n',
      },
      {
        'src/status.ts': status('landed'),
        'src/use.ts': "import { helperFn } from './help.ts';\nhelperFn(1);\n",
        'docs/runs.md': docs.replace('merged', 'landed'),
        'docs/loop.md': 'The bot opens a pull request.\n',
      }
    );
    expect(run(repo)).toEqual({ ok: true, out: 'propagation: ok' });
  });
});
