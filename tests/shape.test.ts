import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { change, runScript } from './kit.ts';

const script = resolve(import.meta.dirname, '../examples/agentgraph/scripts/shape.mjs');
const run = (repo: { dir: string; base: string }) => runScript(script, repo, ['src', 'core']);

const run_ = 'export type Run = { id: string; status: string; started: string; ended: string };\n';

describe('shape', () => {
  it('reports added, removed and moved names, fields, importers and near duplicates', () => {
    const repo = change(
      {
        'src/store.ts': `${run_}export const old = 1;\nexport const keep = 2;\n`,
        'src/a.ts': 'export const helper = 1;\n',
        'src/use.ts': "import { keep } from './store.ts';\nkeep;\n",
      },
      {
        'src/store.ts':
          'export type Run = { id: string; status: string; started: string; ended: string; usd: number };\n' +
          'export const keep = 2;\nexport const fresh = () => 3;\n' +
          'export type RunRow = { id: string; status: string; started: string; ended: string; usd: number; title: string };\n' +
          "export type Brief = Omit<Run, 'usd' | 'ended'>;\n",
        'src/a.ts': 'export const other = 1;\n',
        'src/b.ts': 'export const helper = 1;\n',
        'src/use.ts': "import { keep, fresh, type Brief } from './store.ts';\nkeep;\nfresh;\n",
        'tests/store.test.ts': "import { RunRow } from '../src/store.ts';\n",
      }
    );
    expect(run(repo).out.split('\n')).toEqual([
      '+ src/a.ts: other value (no importer)',
      '+ src/store.ts: fresh function (1 importer, src/use), RunRow type (no importer, 1 test), Brief type (1 importer, src/use)',
      '- src/store.ts: old',
      'moved helper: src/a.ts → src/b.ts',
      '~ src/store.ts Run: +usd',
      'near-duplicate: src/store.ts Run and src/store.ts RunRow share 5 of 6 fields',
      'unused: src/a.ts other',
      'shape: +4 -1 names, 1 moved, +1 -0 fields, cycles 0 → 0, depth 1 → 1, 2 findings',
    ]);
  });

  it('reads fields through zod schemas and z.infer', () => {
    const repo = change(
      {
        'src/schema.ts':
          "import { z } from 'zod';\nexport const Job = z.object({ bot: z.string(), skill: z.string() });\nexport type Job = z.infer<typeof Job>;\n",
      },
      {
        'src/schema.ts':
          "import { z } from 'zod';\nexport const Job = z.object({ bot: z.string(), skill: z.string() }).extend({ tries: z.number() });\nexport type Job = z.infer<typeof Job>;\n",
      }
    );
    expect(run(repo)).toEqual({
      ok: true,
      out: '~ src/schema.ts Job: +tries\nshape: +0 -0 names, 0 moved, +1 -0 fields, cycles 0 → 0, depth 0 → 0, 0 findings',
    });
  });

  it('flags a new import cycle in core/', () => {
    const repo = change(
      {
        'core/a.ts': "import { b } from './b.ts';\nexport const a = b;\n",
        'core/b.ts': 'export const b = 1;\n',
      },
      {
        'core/b.ts': "import { c } from './c.ts';\nexport const b = c;\n",
        'core/c.ts': "import { a } from './a.ts';\nexport const c = 1;\nexport const d = a;\n",
      }
    );
    const { ok, out } = run(repo);
    expect(ok).toBe(false);
    expect(out).toContain('new cycle: core/a, core/b, core/c');
    expect(out).toContain('unused: core/c.ts d');
  });

  it('measures each root on its own, a new one included', () => {
    const repo = change(
      { 'src/a.ts': 'export const a = 1;\n' },
      { 'core/x.ts': "import { y } from './y.ts';\nexport const x = y;\n", 'core/y.ts': 'export const y = 1;\n' }
    );
    expect(run(repo).out.split('\n').slice(-1)).toEqual([
      'shape: +2 -0 names, 0 moved, +0 -0 fields, src: cycles 0 → 0, depth 0 → 0, core: cycles 0 → 0, depth 0 → 1, 1 finding',
    ]);
  });

  it('flags a longer import chain', () => {
    const repo = change(
      { 'src/a.ts': "import { b } from './b.ts';\nexport const a = b;\n", 'src/b.ts': 'export const b = 1;\n' },
      { 'src/b.ts': "import { c } from './c.ts';\nexport const b = c;\n", 'src/c.ts': 'export const c = 1;\n' }
    );
    expect(run(repo).out.split('\n').slice(-2)).toEqual([
      'deeper: longest import chain 1 → 2, src/a > src/b > src/c',
      'shape: +1 -0 names, 0 moved, +0 -0 fields, cycles 0 → 0, depth 1 → 2, 1 finding',
    ]);
  });

  it('leaves a longer chain alone when it comes from breaking a cycle', () => {
    const repo = change(
      {
        'src/a.ts': "import { b } from './b.ts';\nexport const a = b;\n",
        'src/b.ts':
          "import { a } from './a.ts';\nimport { c } from './c.ts';\nexport const b = c;\nexport const d = () => a;\n",
        'src/c.ts': 'export const c = 1;\n',
      },
      { 'src/b.ts': "import { c } from './c.ts';\nexport const b = c;\n" }
    );
    expect(run(repo)).toEqual({
      ok: true,
      out: '- src/b.ts: d\nshape: +0 -1 names, 0 moved, +0 -0 fields, cycles 1 → 0, depth 1 → 2, 0 findings',
    });
  });

  it('passes a change with no TypeScript under the roots', () => {
    const repo = change({ 'src/a.ts': 'export const a = 1;\n' }, { 'README.md': 'hi\n' });
    expect(run(repo)).toEqual({ ok: true, out: 'shape: no TypeScript change under src core' });
  });

  it('is the same script in every hub that runs it', () => {
    const copy = resolve(import.meta.dirname, '../examples/acme-app/scripts/shape.mjs');
    expect(readFileSync(copy, 'utf8')).toBe(readFileSync(script, 'utf8'));
  });
});
