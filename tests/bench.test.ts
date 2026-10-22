import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  armSlot,
  bootstrap,
  costOf,
  couplings,
  family,
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
  spent,
  stats,
  unbiased,
  unpriced,
  verdict,
} from '../bin/bench.ts';
import { git, tmp } from './fixtures.ts';

const cli = join(import.meta.dirname, '..', 'bin', 'bench.ts');

/** A stand-in docker client that runs a score container's `sh -c` on the host, in the dir bound at `/work`. */
const hostDocker = (image = true) => {
  const bin = tmp('bin');
  writeFileSync(
    join(bin, 'docker'),
    [
      '#!/bin/sh',
      ...(image ? [] : ['[ "$1" = image ] && exit 1']),
      '[ "$1" = run ] || exit 0',
      'for a; do case "$a" in type=bind,src=*,dst=/work) dir=${a#type=bind,src=}; dir=${dir%,dst=/work};; esac; done',
      'while [ $# -gt 1 ] && [ "$1" != -c ]; do shift; done',
      'cd "$dir" && exec sh "$@"',
    ].join('\n')
  );
  chmodSync(join(bin, 'docker'), 0o755);
  return { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, AGENTGRAPH_CACHE_VOLUME: '' };
};
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
+// see #12 from agentgraph
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
    expect(out).not.toMatch(/package-lock|^index |#12|agentgraph/m);
    expect(out).toContain('+// see #N from someone');
  });

  it('drops build info and git hooks from both sides of a judged pair', () => {
    const extra = ['tsconfig.tsbuildinfo', '.husky/pre-commit', 'pnpm-lock.yaml', 'bun.lock']
      .map(f => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-old\n+new\n`)
      .join('');
    const out = scrub(diff + extra);
    expect(out).not.toMatch(/tsbuildinfo|husky|pnpm-lock|bun\.lock/);
    expect(out).toContain('src/a.test.ts');
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
    expect(invalid({ applied: true }, ok, true)).toMatch(/no hidden tests run/);
    expect(invalid(ok, ok)).toMatch(/base already passes/);
    expect(invalid(red, { ...ok, hidden: { ok: false } })).toMatch(/human fails the hidden/);
    expect(invalid(red, { ...ok, suite: { ok: false } })).toMatch(/human fails the suite/);
    expect(invalid(red, { applied: false })).toMatch(/does not apply/);
    expect(invalid(red, { ...ok, setup: { ok: false } })).toMatch(/setup fails/);
    expect(invalid(red, { ...ok, typecheck: { ok: false } })).toMatch(/human fails the typecheck/);
    expect(invalid({ applied: true }, { applied: true, typecheck: { ok: false } })).toMatch(
      /human fails the typecheck/
    );
    expect(invalid({ applied: true }, { applied: true, typecheck: { ok: true } })).toBeUndefined();
  });

  it('calls hidden tests coupled when they import what only the human adds, or check a snapshot', () => {
    const file = (path: string, lines: string[], fresh = false) =>
      `diff --git a/${path} b/${path}\n${fresh ? 'new file mode 100644\n--- /dev/null\n' : `--- a/${path}\n`}+++ b/${path}\n@@ -0,0 +1 @@\n${lines.map(l => `+${l}`).join('\n')}\n`;
    const texts: Record<string, string> = {
      'src/utils.ts': 'export const old = 1;\n',
      'src/index.ts': 'export * from "./utils";\n',
      'packages/common/src/index.ts': 'export const other = 1;\n',
      'src/lib.rs': '',
    };
    const base = { files: Object.keys(texts), text: (p: string) => texts[p] ?? '', has: (w: string) => w === 'old' };
    const test = (lines: string[], path = 'src/__tests__/a.test.ts') => file(path, lines, true);

    const added = file('src/display-name.ts', ['export const displayName = 1;'], true);
    const imports = test(["import { displayName } from '../display-name';", 'expect(displayName).toBe(1);']);
    expect(couplings(added + imports, 'Show the name', base)).toEqual([
      'src/__tests__/a.test.ts: imports ../display-name, which only the human adds',
    ]);
    expect(couplings(added + imports, 'Add a display-name helper', base)).toEqual([]);

    const exported = file('src/utils.ts', ['export const fresh = 2;']);
    const names = test(["import { old, fresh as f } from '../utils';", 'expect(f).toBe(2);']);
    expect(couplings(exported + names, 'Add a value', base)).toEqual([
      'src/__tests__/a.test.ts: imports fresh from ../utils, which only the human exports',
    ]);
    expect(couplings(exported + names, 'Add `fresh`', base)).toEqual([]);
    expect(couplings(exported + test(["import { fresh } from '@/index';"]), 'x', base)).toEqual([]);
    expect(couplings(exported + test(["import { fresh } from '@scope/common';"]), 'x', base)).toEqual([
      'src/__tests__/a.test.ts: imports fresh from @scope/common, which only the human exports',
    ]);
    expect(couplings(test(["import { old } from '../utils';", 'expect(old).toBe(1);']), 'x', base)).toEqual([]);

    expect(couplings(test(['expect(render(<Nav />)).toMatchSnapshot();']), 'x', base)).toEqual([
      'src/__tests__/a.test.ts: snapshot',
    ]);
    expect(couplings(test(['expect(a).toBe(1);', 'expect(b).toMatchSnapshot();']), 'x', base)).toEqual([]);
    const snap = file('src/__tests__/__snapshots__/a.test.ts.snap', ['exports[`a`] = `<div />`;']);
    expect(couplings(snap, 'x', base)).toEqual(['src/__tests__/__snapshots__/a.test.ts.snap: snapshot']);

    const rust =
      file('src/lib.rs', ['pub fn fresh_fn() {}']) + test(['use crate::lib::{old, fresh_fn};'], 'tests/cli.rs');
    expect(couplings(rust, 'Fix the deploy', base)).toEqual([
      'tests/cli.rs: uses fresh_fn, which only the human defines',
    ]);
  });

  it('calls a failed setup, an unfinished run or a broken environment infra, and an empty diff a result', () => {
    expect(infra({})).toBeUndefined();
    expect(infra({ infra: 'empty diff' })).toBeUndefined();
    expect(infra({ setup: { ok: false } })).toBe('setup fails');
    expect(infra({ status: 'running' })).toBe('run did not finish');
    expect(infra({ infra: 'boom' })).toBe('boom');
    expect(infra({ status: 'waiting', setup: { ok: true } })).toBeUndefined();
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

  it('swaps a judge of the contestant family for one of another family', () => {
    const aliases = {
      smart: 'chatgpt/gpt-6.1-sol',
      luna: 'chatgpt/gpt-6-luna',
      gemini: 'openrouter/google/gemini-4-argon',
      glm: 'openrouter/z-ai/glm-5.3',
    };
    expect(family('luna', aliases)).toBe('openai');
    expect(family('glm', aliases)).toBe('z-ai');
    expect(family('claude-opus', aliases)).toBe('anthropic');
    expect(unbiased({ sol: 1 }, 'glm', aliases)).toEqual({ sol: 1 });
    expect(unbiased({ sol: 1 }, 'luna', aliases)).toEqual({ gemini: 1 });
    expect(unbiased({ opus: 1, sonnet: 2, sol: 2 }, 'smart', aliases)).toEqual({ opus: 1, sonnet: 2, gemini: 2 });
    expect(unbiased({ opus: 1, sol: 2 }, 'claude-sonnet', aliases)).toEqual({ gemini: 1, sol: 2 });
  });

  it('gives a bootstrap interval around the mean', () => {
    expect(bootstrap([1, 1, 1])).toEqual([1, 1]);
    const [low, high] = bootstrap([0, 1, 0, 1, 1, 0, 1, 1]);
    expect(low).toBeLessThan(0.625);
    expect(high).toBeGreaterThan(0.625);
  });
});

describe('bin/bench.ts score and report', () => {
  it('runs the merged tests on each arm, keeps scores, and skips them on a rerun', { timeout: 30_000 }, () => {
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

    const missing = spawnSync(process.execPath, [cli, 'score', kase, out, '--repo', repo], {
      encoding: 'utf8',
      env: hostDocker(false),
    });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('score needs docker');
    expect(existsSync(join(out, 'demo', 'base', 'score.json'))).toBe(false);

    const env = hostDocker();
    const bench = (...args: string[]) => {
      const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env });
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
    expect(report).toContain('1 valid cases, 1 invalid, 0 infra arm runs.');
    expect(report).toContain('| v2 | 1 | 1 | 1 |');
    expect(report).toContain('| floor | 0 | 1 | 0 |');
    expect(report).toContain('- bad: base already passes the hidden tests');
    expect(report).not.toContain('- demo/floor: empty diff');
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
      usdSource: 'list-price estimate',
    });
    expect(rows[0]!.findings.high).toBe(0.25);
    expect(rows[2]).toMatchObject({ outcome: 'no-change', hidden: 0, vsHuman: {} });
    expect(rows[2]).not.toHaveProperty('infra');
    expect(rows[1]).not.toHaveProperty('outcome');
    const point = { harness: 'pi', model: 'luna', engine: 'abc', hubs: { v2: 'h2' }, set: 'core@1', repeat: 2 };
    writeFileSync(join(out, 'point.json'), JSON.stringify(point));
    expect(rowsOf(out).map(r => [r.point, r.repeat])[1]).toEqual(['pi:luna/v2@abc/h2/core@1', 2]);
    writeFileSync(join(out, 'demo', 'base', 'score.json'), JSON.stringify({ ...score('base'), suite: { ok: false } }));
    expect(rowsOf(out)[1]).not.toHaveProperty('suite');
    mkdirSync(join(out, 'btc', 'human'), { recursive: true });
    writeFileSync(join(out, 'btc', 'case.json'), JSON.stringify({ repo: 'acme/billing' }));
    writeFileSync(join(out, 'btc', 'human', 'score.json'), '{}');
    expect(rowsOf(out).map(r => r.case)).toEqual(['demo', 'demo', 'demo']);
    expect(rowsOf(out, ['me/other'])).toEqual([]);
    expect(rowsOf(out, ['me/demo'])).toHaveLength(3);
    expect(bench('report', out)).not.toContain('btc');
  });
});

describe('bin/bench.ts typecheck', () => {
  it('typechecks a case without hidden tests and calls it invalid when the human fails it', { timeout: 30_000 }, () => {
    const root = tmp('bench');
    dirs.push(root);
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.js'), 'ok\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD').trim();
    writeFileSync(join(repo, 'a.js'), 'bad\n');
    git(repo, 'commit', '-q', '-am', 'change');
    const merged = git(repo, 'rev-parse', 'HEAD').trim();
    const kase = join(root, 'cases', 'demo');
    mkdirSync(kase, { recursive: true });
    const typecheck = 'grep -q ok a.js';
    writeFileSync(
      join(kase, 'case.json'),
      JSON.stringify({ repo: 'me/demo', base, merged, bucket: 'no-tests', typecheck })
    );
    writeFileSync(join(kase, 'issue.md'), '# Change a\n\nChange it.\n');
    writeFileSync(join(kase, 'merged.diff'), git(repo, 'diff', base, merged));
    const out = join(root, 'out');
    const r = spawnSync(process.execPath, [cli, 'score', kase, out, '--repo', repo], {
      encoding: 'utf8',
      env: hostDocker(),
    });
    expect(r.status, r.stderr).toBe(0);
    const score = (arm: string) => JSON.parse(readFileSync(join(out, 'demo', arm, 'score.json'), 'utf8'));
    expect(score('base')).toMatchObject({ applied: true, typecheck: { ok: true } });
    expect(score('base')).not.toHaveProperty('hidden');
    expect(score('human')).toMatchObject({ typecheck: { ok: false } });
    expect(JSON.parse(readFileSync(join(out, 'demo', 'valid.json'), 'utf8'))).toEqual({
      invalid: 'the human fails the typecheck',
    });
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

  it('gives an agent with no key of its own the implementor key', () => {
    const hub = tmp('hub');
    dirs.push(hub);
    mkdirSync(join(hub, 'agents'));
    for (const name of ['implementor', 'scout']) writeFileSync(join(hub, 'agents', `${name}.md`), '---\n---\n');
    const before = process.env.AGENTGRAPH_PROXY_KEYS;
    process.env.AGENTGRAPH_PROXY_KEYS = 'implementor=ki,reviewer=kr';
    repoint(hub, 'opencode:none');
    const keys = process.env.AGENTGRAPH_PROXY_KEYS;
    if (before === undefined) delete process.env.AGENTGRAPH_PROXY_KEYS;
    else process.env.AGENTGRAPH_PROXY_KEYS = before;
    expect(keys).toBe('implementor=ki,reviewer=kr,scout=ki');
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
    const tokens = { smart: { input: 15, cacheRead: 80, cacheWrite: 5, output: 7 } };
    expect(JSON.parse(readFileSync(join(root, 'kept', 'usage.json'), 'utf8'))).toEqual({
      sessions: 1,
      usd: 0.5,
      ms: 0,
      tokens,
      attempts: [{ dir: 'v2', ms: 0, sessions: 1, usd: 0.5, tokens }],
    });
  });

  it('sums usage and time over every attempt of an arm, set-aside ones included', () => {
    const root = tmp('attempts');
    dirs.push(root);
    const attempt = (dir: string, usd: number, meta?: object) => {
      mkdirSync(join(root, dir, 'data', 'run-1'), { recursive: true });
      const trace = [
        { at: '2026-10-22T10:00:00.000Z', key: 'k', event: { type: 'start', model: 'luna' } },
        { at: '2026-10-22T10:00:30.000Z', key: 'k', event: { type: 'usage', input: 10, output: 2 } },
        { at: '2026-10-22T10:01:00.000Z', key: 'k', session: { usd } },
      ];
      writeFileSync(join(root, dir, 'data', 'run-1', 'trace.jsonl'), trace.map(t => JSON.stringify(t)).join('\n'));
      if (meta) writeFileSync(join(root, dir, 'meta.json'), JSON.stringify(meta));
    };
    attempt('v2', 0.5, { ms: 1000 });
    attempt('.attic/v2-2026-10-22T09-00-00-000Z', 0.25, { ms: 2000, infra: 'SandboxError: no image' });
    attempt('v2.1792493424355', 0.125);
    attempt('.attic/floor-2026-10-22T09-00-00-000Z', 9, { ms: 9 });
    const all = spent(join(root, 'v2'));
    expect(all).toMatchObject({ sessions: 3, usd: 0.875, ms: 63_000 });
    expect(all.tokens).toEqual({ luna: { input: 30, cacheRead: 0, cacheWrite: 0, output: 6 } });
    expect(all.attempts.map(a => [a.dir, a.ms, a.usd, a.infra])).toEqual([
      ['v2.1792493424355', 60_000, 0.125, undefined],
      ['.attic/v2-2026-10-22T09-00-00-000Z', 2000, 0.25, 'SandboxError: no image'],
      ['v2', 1000, 0.5, undefined],
    ]);
  });
});

describe('prices', () => {
  it('names the models of an arm that have no list price, so a bench stops before it spends', () => {
    const hub = tmp('hub');
    dirs.push(hub);
    mkdirSync(join(hub, 'agents'));
    writeFileSync(join(hub, 'agents', 'implementor.md'), '---\nharness: opencode\nmodel: smart\n---\n');
    writeFileSync(join(hub, 'agents', 'scout.md'), '---\nharness: opencode\nmodel: mystery\n---\n');
    expect(unpriced('v2', hub, undefined)).toEqual(['mystery']);
    expect(unpriced('v2', hub, 'opencode:deepseek-flash')).toEqual([]);
    expect(unpriced('v2', hub, 'opencode:nope')).toEqual(['nope']);
    expect(unpriced('floor', hub, undefined)).toEqual([]);
  });

  it('reprices tokens when a run recorded no cost, and marks subscription cost as an estimate', () => {
    const prices = {
      aliases: { luna: 'chatgpt/gpt-6-luna', flash: 'openrouter/deepseek/deepseek-v4.1-flash' },
      models: {
        'gpt-6-luna': { input: 0.1, cached: 0.01, output: 0.5 },
        'deepseek-v4.1-flash': { input: 0.3, cached: 0.006, output: 1.2 },
      },
      subscriptions: ['chatgpt/'],
    };
    const t = { input: 1e6, cacheRead: 1e6, cacheWrite: 1e6, output: 1e6 };
    expect(costOf({ usd: 0, tokens: { flash: t } }, 'opencode', prices)).toEqual({
      usd: 0.3 + 0.006 + 0.3 + 1.2,
      usdSource: 'list price',
    });
    expect(costOf({ usd: 2, tokens: { flash: t } }, 'opencode', prices)).toEqual({ usd: 2, usdSource: 'recorded' });
    expect(costOf({ usd: 0.5, tokens: { luna: t } }, 'opencode', prices).usdSource).toBe('list-price estimate');
    expect(costOf({ usd: 0, tokens: { luna: t } }, 'opencode', prices)).toEqual({
      usd: 0.71,
      usdSource: 'list-price estimate',
    });
    expect(costOf({ usd: 1 }, 'claude-sub', prices).usdSource).toBe('list-price estimate');
    expect(costOf({ usd: 0, tokens: { mystery: t } }, 'opencode', prices)).toEqual({ usd: 0, usdSource: 'unpriced' });
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
      typecheck: 'cargo check --tests',
    });
    expect(plan('acme/clarinet', ['components/clarinet-format/tests/golden/a.clar'])).toEqual({
      test: 'cargo test -p clarinet-format --tests',
      typecheck: 'cargo check --tests',
    });
    expect(plan('acme/clarinet', ['components/clarity-repl/src/analysis/coverage_tests.rs']).test).toBe(
      'cargo test -p clarity-repl --lib analysis::coverage_tests'
    );
    expect(plan('acme/clarinet', ['components/clarinet-sdk/node/tests/a.test.ts'])).toMatchObject({
      setup: expect.stringContaining('build.mjs'),
      test: "(cd components/clarinet-sdk/node && npx vitest run 'tests/a.test.ts')",
    });
    expect(plan('acme/explorer', ['src/a/__tests__/__snapshots__/B.test.tsx.snap']).test).toContain(
      "'src/a/__tests__/B.test.tsx'"
    );
    expect(plan('acme/stacks.js', [])).toEqual({
      hasTests: false,
      setup: 'npm ci --no-audit --no-fund --ignore-scripts',
      typecheck: 'npm run typecheck --workspaces --if-present',
    });
    expect(plan('acme/explorer', ['README.md'])).toMatchObject({ hasTests: false, typecheck: expect.any(String) });
    expect(plan('acme/billing', [])).toEqual({ hasTests: false });
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
