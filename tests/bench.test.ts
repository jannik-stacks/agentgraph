import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bootstrap,
  infra,
  invalid,
  orders,
  pad,
  parsePanel,
  plan,
  plant,
  scrub,
  stats,
  verdict,
} from '../bin/bench.ts';
import { git, tmp } from './fixtures.ts';

const cli = join(import.meta.dirname, '..', 'bin', 'bench.ts');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const diff = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
-const a = 1;
+// see #12 from bothub
+if (x && y) return 1;
 keep();
diff --git a/src/a.test.ts b/src/a.test.ts
--- a/src/a.test.ts
+++ b/src/a.test.ts
@@ -0,0 +1,1 @@
+it('works', () => {});
diff --git a/package-lock.json b/package-lock.json
--- a/package-lock.json
+++ b/package-lock.json
@@ -1 +1 @@
-old
+new
`;

describe('bench helpers', () => {
  it('counts source and test lines, test cases, branch tokens and file overlap', () => {
    expect(stats(diff, ['src/a.ts', 'src/b.ts'])).toEqual({
      files: 2,
      srcAdded: 2,
      srcRemoved: 1,
      testsAdded: 1,
      testsRemoved: 0,
      testCases: 1,
      complexity: 2,
      overlap: 0.333,
    });
  });

  it('drops lockfiles and index lines and masks issue numbers and names', () => {
    const out = scrub(diff, ['morgan']);
    expect(out).not.toMatch(/package-lock|^index |#12|bothub/m);
    expect(out).toContain('+// see #N from someone');
  });

  it('reads the last JSON block of a judge answer and needs a preference', () => {
    expect(verdict('x\n```json\n{"prefer":"B"}\n```\nmore\n```json\n{"prefer":"A","A":{"findings":[]}}\n```')).toEqual({
      prefer: 'A',
      A: { findings: [] },
    });
    expect(verdict('```json\n{"prefer":"maybe"}\n```')).toBeUndefined();
    expect(verdict('no block')).toBeUndefined();
  });

  it('marks a case invalid unless the hidden tests fail on base and pass on the human', () => {
    const ok = { applied: true, hidden: { ok: true }, suite: { ok: true } };
    const red = { applied: true, hidden: { ok: false } };
    expect(invalid(red, ok)).toBeUndefined();
    expect(invalid({ applied: true }, { applied: true })).toBeUndefined();
    expect(invalid(ok, ok)).toMatch(/base already passes/);
    expect(invalid(red, { ...ok, hidden: { ok: false } })).toMatch(/human fails the hidden/);
    expect(invalid(red, { ...ok, suite: { ok: false } })).toMatch(/human fails the suite/);
    expect(invalid(red, { applied: false })).toMatch(/does not apply/);
    expect(invalid(red, { ...ok, setup: { ok: false } })).toMatch(/setup fails/);
  });

  it('calls an empty diff, a failed setup or an unfinished run infra, not a result', () => {
    expect(infra({ files: 0 })).toBe('empty diff');
    expect(infra({ files: 2, setup: { ok: false } })).toBe('setup fails');
    expect(infra({ files: 2, status: 'running' })).toBe('run did not finish');
    expect(infra({ files: 0, infra: 'boom' })).toBe('boom');
    expect(infra({ files: 2, status: 'waiting', setup: { ok: true } })).toBeUndefined();
  });

  it('plants one flipped comparison in a source line and pads with tests', () => {
    const src = diff.replace('if (x && y) return 1;', 'if (n >= 2) return 1;');
    const bug = plant(src)!;
    expect(bug).toContain('+if (n > 2) return 1;');
    expect(bug.replace('n > 2', 'n >= 2')).toBe(src);
    expect(plant(diff)).toBeUndefined();
    const padded = stats(pad(diff));
    expect(padded.testCases).toBe(stats(diff).testCases + 20);
    expect(padded.srcAdded).toBe(stats(diff).srcAdded);
  });

  it('reads one order for a one-order judge, picked by the key, and both for the rest', () => {
    const panel = parsePanel('opus:1,sonnet:2,sol:2');
    expect(panel).toEqual({ opus: 1, sonnet: 2, sol: 2 });
    const calls = (key: string) => Object.values(panel).reduce((n, count) => n + orders(count, key).length, 0);
    expect(calls('demo/human-v2')).toBe(5);
    expect(orders(1, 'demo/human-v2')).toEqual(orders(1, 'demo/human-v2'));
    const picks = ['a', 'b', 'c', 'd'].map(k => orders(1, k)[0]);
    expect(new Set(picks)).toEqual(new Set([0, 1]));
    expect(() => parsePanel('opus:3')).toThrow(/bad --judges/);
    expect(() => parsePanel('gpt:1')).toThrow(/bad --judges/);
  });

  it('gives a bootstrap interval around the mean', () => {
    expect(bootstrap([1, 1, 1])).toEqual([1, 1]);
    const [low, high] = bootstrap([0, 1, 0, 1, 1, 0, 1, 1]);
    expect(low).toBeLessThan(0.625);
    expect(high).toBeGreaterThan(0.625);
  });
});

describe('bin/bench.ts score and report', () => {
  it('runs the merged tests on each arm, keeps scores, and skips them on a rerun', () => {
    const root = tmp('bench');
    dirs.push(root);
    const repo = join(root, 'repo');
    mkdirSync(join(repo, 'test'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'sum.js'), 'module.exports = (a, b) => a - b;\n');
    writeFileSync(join(repo, 'test', 'run.js'), 'process.exit(0);\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD').trim();
    writeFileSync(join(repo, 'sum.js'), 'module.exports = (a, b) => a + b;\n');
    writeFileSync(join(repo, 'test', 'run.js'), "process.exit(require('../sum.js')(1, 2) === 3 ? 0 : 1);\n");
    git(repo, 'commit', '-q', '-am', 'fix');
    const merged = git(repo, 'rev-parse', 'HEAD').trim();

    const kase = join(root, 'cases', 'demo');
    mkdirSync(kase, { recursive: true });
    const json = {
      repo: 'me/demo',
      base,
      merged,
      title: 'Fix sum',
      test: 'node test/run.js',
      kind: 'bug',
      flags: ['no-issue-pr-body'],
    };
    writeFileSync(join(kase, 'case.json'), JSON.stringify(json));
    writeFileSync(join(kase, 'issue.md'), '# Fix sum\n\nsum subtracts.\n');
    writeFileSync(join(kase, 'merged.diff'), git(repo, 'diff', base, merged));
    const out = join(root, 'out');
    mkdirSync(join(out, 'demo', 'v2'), { recursive: true });
    writeFileSync(join(out, 'demo', 'v2', 'diff.patch'), git(repo, 'diff', base, merged, '--', 'sum.js'));

    const bench = (...args: string[]) => {
      const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      return r.stdout;
    };
    bench('score', kase, out, '--repo', repo);
    const score = (arm: string) => JSON.parse(readFileSync(join(out, 'demo', arm, 'score.json'), 'utf8'));
    expect(score('base')).toMatchObject({ applied: true, suite: { ok: true }, hidden: { ok: false } });
    expect(score('v2')).toMatchObject({ applied: true, hidden: { ok: true }, srcAdded: 1, overlap: 0.5 });
    expect(score('human')).toMatchObject({ hidden: { ok: true }, testsAdded: 1, overlap: 1 });

    bench('score', kase, out, '--repo', repo);
    expect(JSON.parse(readFileSync(join(out, 'demo', 'valid.json'), 'utf8'))).toEqual({});
    const log = readFileSync(join(out, 'log.jsonl'), 'utf8').trim().split('\n');
    expect(log.filter(l => l.includes('"event":"end"'))).toHaveLength(3);
    const said = (order: string, judge: string, prefer: string) => {
      mkdirSync(join(out, 'demo', 'judge', order), { recursive: true });
      const high = { findings: [{ severity: 'high', category: 'tests', text: 'no test' }] };
      const v = { judge, order: order.split('-'), prefer, ...(prefer === 'A' ? { B: high } : { A: high }) };
      writeFileSync(join(out, 'demo', 'judge', order, `${judge}.json`), JSON.stringify(v));
    };
    said('human-v2', 'opus', 'A');
    said('v2-human', 'opus', 'B');
    said('human-v2', 'sonnet', 'A');
    said('v2-human', 'sonnet', 'A');
    const report = bench('report', out);
    expect(report).toContain('| human vs v2 | 1 | 0.75 | 0.75 to 0.75 |');
    expect(report).toContain('| v2 | 3 |');
    expect(report).toContain('## kind bug, 1 cases');
    expect(report).toContain('## issue pr-body, 1 cases');
    expect(report).toContain('Judges agree, order-consistent, on 0 of 1 case pairs.');
    expect(report).toContain('| v2 | 1 | 1 | 1 | 1 | 1 | 1 |');
  });
});

describe('plan', () => {
  it('turns the miner test file list into a test command per repo', () => {
    expect(plan('acme/explorer', ['src/a/[id]/x.test.ts', 'src/a/fixture.json'])).toMatchObject({
      test: expect.stringContaining("--runTestsByPath 'src/a/[id]/x.test.ts'"),
      setup: expect.stringContaining('pnpm@10.28.2 install'),
    });
    expect(plan('acme/stacks.js', ['packages/api/tests/a.test.ts', 'packages/auth/tests/setup.js']).test).toBe(
      "(cd packages/api && npx jest --runTestsByPath 'tests/a.test.ts')"
    );
    expect(plan('acme/clarinet', ['components/clarinet-deployments/tests/remap.rs', 'x/a.test.ts'])).toEqual({
      test: 'cargo test -p clarinet-deployments --test remap',
    });
    expect(plan('acme/clarinet', ['components/clarinet-sdk/node/tests/a.test.ts'])).toEqual({ hasTests: false });
    expect(plan('acme/stacks.js', [])).toEqual({ hasTests: false });
  });
});
