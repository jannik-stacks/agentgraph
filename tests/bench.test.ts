import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  armSlot,
  bootstrap,
  infra,
  invalid,
  orders,
  pad,
  parsePanel,
  plan,
  plant,
  keep,
  repoint,
  rowsOf,
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
    const tokens = { smart: { input: 10, cacheRead: 90, cacheWrite: 0, output: 5 } };
    writeFileSync(join(out, 'demo', 'v2', 'usage.json'), JSON.stringify({ sessions: 2, usd: 0.25, tokens }));

    const bench = (...args: string[]) => {
      const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      return r.stdout;
    };
    bench('score', kase, out, '--repo', repo);
    const score = (arm: string) => JSON.parse(readFileSync(join(out, 'demo', arm, 'score.json'), 'utf8'));
    expect(score('base')).toMatchObject({ applied: true, suite: { ok: true }, hidden: { ok: false } });
    expect(score('v2')).toMatchObject({ applied: true, hidden: { ok: true }, srcAdded: 1, overlap: 0.5, usd: 0.25 });
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
    mkdirSync(join(out, 'demo', 'floor'), { recursive: true });
    writeFileSync(join(out, 'demo', 'floor', 'score.json'), JSON.stringify({ files: 0, hidden: { ok: false } }));
    mkdirSync(join(out, 'bad', 'human'), { recursive: true });
    writeFileSync(join(out, 'bad', 'valid.json'), JSON.stringify({ invalid: 'base already passes the hidden tests' }));
    const report = bench('report', out);
    expect(report).toContain('1 valid cases, 1 invalid, 1 infra arm runs.');
    expect(report).toContain('| v2 | 1 | 1 | 1 |');
    expect(report).not.toContain('| floor |');
    expect(report).toContain('- bad: base already passes the hidden tests');
    expect(report).toContain('- demo/floor: empty diff');
    expect(report).toContain('| human vs v2 | 1 | 0.75 | 0.75 to 0.75 |');
    expect(report).toContain('| v2 | 3 |');
    expect(report).toContain('## kind bug, 1 cases');
    expect(report).toContain('## issue pr-body, 1 cases');
    expect(report).toContain('Judges agree, order-consistent, on 0 of 1 case pairs.');
    expect(report).toContain('| v2 | 1 | 1 | 1 | 1 | 1 | 1 |');

    const rows = rowsOf(out);
    expect(rows.map(r => r.point)).toEqual([
      'opencode:smart/human@unknown//out',
      'opencode:smart/v2@unknown//out',
      'opencode:smart/floor@unknown//out',
    ]);
    expect(rows[1]).toMatchObject({
      case: 'demo',
      repeat: 1,
      strata: { kind: 'bug', issue: 'pr-body' },
      hidden: 1,
      suite: 1,
      vsHuman: { opus: 0, sonnet: 0.5 },
      findings: { critical: 0, high: 0.75 },
      tokens,
      usd: 0.25,
    });
    expect(rows[0]!.findings.high).toBe(0.25);
    expect(rows[2]).toMatchObject({ infra: 'empty diff', vsHuman: {} });
    const point = { harness: 'pi', model: 'luna', engine: 'abc', hubs: { v2: 'h2' }, set: 'core@1', repeat: 2 };
    writeFileSync(join(out, 'point.json'), JSON.stringify(point));
    expect(rowsOf(out).map(r => [r.point, r.repeat])[1]).toEqual(['pi:luna/v2@abc/h2/core@1', 2]);
  });
});

describe('points', () => {
  it('rewrites only the harness and model of each agent front matter', () => {
    const hub = tmp('hub');
    dirs.push(hub);
    mkdirSync(join(hub, 'agents'));
    const agent = '---\nharness: opencode\nmodel: smart\n---\nmodel: keep this line\n';
    writeFileSync(join(hub, 'agents', 'implementor.md'), agent);
    repoint(hub, 'pi:luna');
    expect(readFileSync(join(hub, 'agents', 'implementor.md'), 'utf8')).toBe(
      '---\nharness: pi\nmodel: luna\n---\nmodel: keep this line\n'
    );
  });

  it('keys an arm by point and repeat only when one is given', () => {
    const cache = tmp('cache');
    dirs.push(cache);
    process.env.BENCH_CACHE = cache;
    const c = { id: 'demo', base: 'abc', repo: 'me/demo' };
    const plain = armSlot(c, 'floor');
    expect(armSlot(c, 'floor', { point: undefined, repeat: 1 })).toBe(plain);
    const luna = armSlot(c, 'floor', { point: 'opencode:luna', repeat: 1 });
    const again = armSlot(c, 'floor', { point: 'opencode:luna', repeat: 2 });
    delete process.env.BENCH_CACHE;
    expect(new Set([plain, luna, again]).size).toBe(3);
    expect(armSlot(c, 'floor')).toBeUndefined();
  });

  it('keys an arm by the BENCH_HUB content, so an unchanged hub hits the cache', () => {
    const [cache, hub] = [tmp('cache'), tmp('hub')];
    dirs.push(cache, hub);
    writeFileSync(join(hub, 'hub.yaml'), 'repo: me/demo\n');
    process.env.BENCH_CACHE = cache;
    const c = { id: 'demo', base: 'abc', repo: 'me/demo' };
    const plain = armSlot(c, 'v2');
    process.env.BENCH_HUB = hub;
    const tuned = armSlot(c, 'v2');
    const again = armSlot(c, 'v2');
    writeFileSync(join(hub, 'hub.yaml'), 'repo: me/demo\nlimits: { minutes: 5 }\n');
    const changed = armSlot(c, 'v2');
    delete process.env.BENCH_HUB;
    delete process.env.BENCH_CACHE;
    expect(tuned).not.toBe(plain);
    expect(again).toBe(tuned);
    expect(changed).not.toBe(tuned);
  });

  it('writes the usage of an arm before caching it without its data', () => {
    const root = tmp('keep');
    dirs.push(root);
    const at = join(root, 'v2');
    mkdirSync(join(at, 'data', 'run-1'), { recursive: true });
    const trace = [
      { key: 'k', event: { type: 'start', model: 'smart' } },
      { key: 'k', event: { type: 'usage', input: 100, cacheRead: 80, cacheWrite: 5, output: 7 } },
      { key: 'k', session: { usd: 0.5 } },
    ];
    writeFileSync(join(at, 'data', 'run-1', 'trace.jsonl'), trace.map(t => JSON.stringify(t)).join('\n'));
    keep(at, join(root, 'kept'));
    expect(existsSync(join(root, 'kept', 'data'))).toBe(false);
    expect(JSON.parse(readFileSync(join(root, 'kept', 'usage.json'), 'utf8'))).toEqual({
      sessions: 1,
      usd: 0.5,
      tokens: { smart: { input: 15, cacheRead: 80, cacheWrite: 5, output: 7 } },
    });
  });
});

describe('plan', () => {
  it('turns the miner test file list into a test command per repo', () => {
    expect(plan('acme/explorer', ['src/a/[id]/x.test.ts', 'src/a/fixture.json'])).toMatchObject({
      test: expect.stringContaining("--runTestsByPath 'src/a/[id]/x.test.ts'"),
      setup: expect.stringContaining("'10.28.2'"),
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

describe('run comparison', () => {
  const report = (rate: number) =>
    `# Bench report\n\n3 valid cases.\n\nHidden tests passed\n\n| arm | passed | of | rate |\n|---|---|---|---|\n| v2 | 1 | 3 | ${rate} |\n\n## All\n`;
  it('lists only the headline rows that changed', async () => {
    const { compare } = await import('../bin/bench-run.ts');
    expect(compare(report(0.33), report(0.33))).toEqual([]);
    expect(compare(report(0.33), report(0.67))).toEqual(['- Hidden tests passed / v2: 1 | 3 | 0.33 -> 1 | 3 | 0.67']);
  });
});
