import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const fixtures = join(import.meta.dirname, 'fixtures', 'bench');
const run = () =>
  JSON.parse(
    execFileSync(
      'node',
      ['bench/compare.mjs', '--repo', fixtures, '--a', join(fixtures, 'a.diff'), '--b', join(fixtures, 'b.diff')],
      { cwd: join(import.meta.dirname, '..'), encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } }
    )
  );

describe('bench compare', () => {
  it('measures size, symbol overlap, tests and style of two diffs', () => {
    const out = run();
    expect(out.size.a).toMatchObject({ files: 2, src: 3, tests: 5 });
    expect(out.size.b).toMatchObject({ files: 1, src: 2, tests: 0 });
    expect(out.overlap.symbolJaccard).toBe(0.5);
    expect(out.overlap.bLinesTouchedByA).toBe(1);
    expect(out.scopeCreep.extraFiles).toEqual(['tests/base.test.ts']);
    expect(out.tests.a).toMatchObject({ cases: 1, assertions: 2, tautologies: 1, still: 1 });
    expect(out.style.a.historyComments).toHaveLength(1);
    expect(out.style.a.risky).toBe(1);
  });
});
