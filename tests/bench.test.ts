import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseBenchJudgeResponse,
  armSlot,
  bootstrap,
  getBenchUsageCost,
  couplings,
  getModelMakerFromUpstreamName,
  hiddenShare,
  infra,
  invalid,
  orders,
  pad,
  parsePanel,
  pickBenchTestCommands,
  plant,
  keep,
  readBenchKeys,
  repoint,
  reuse,
  readBenchRows,
  scrub,
  readArmUsageOverAttempts,
  stats,
  makeCrossMakerJudgePanel,
  unpriced,
  parseBenchJudgeVerdict,
} from '../bin/bench.ts';
import { git, tmp } from './kit.ts';

const cli = join(import.meta.dirname, '..', 'bin', 'bench.ts');

/** A stand-in docker client that runs a score container's `sh -c` on the host, in the dir bound at `/work`. */
const hostDocker = (image = true) => {
  const bin = tmp('bin');
  writeFileSync(
    join(bin, 'docker'),
    [
      '#!/bin/sh',
      ...(image ? [] : ['[ "$1" = image ] && exit 1']),
      '[ "$1 $3" = "image --format" ] && echo "${FAKE_IMAGE_ID:-sha256:one}" && exit 0',
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
  delete process.env.BENCH_EXCLUDE;
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
    const out = scrub(diff, ['robin']);
    expect(out).not.toMatch(/package-lock|^index |#12|agentgraph/m);
    expect(out).toContain('+// see #N from someone');
  });

  it('scores hidden tests as the share base fails that a run passes, from jest, vitest, cargo or node counts', () => {
    const jest = (failed: number, passed: number) =>
      `Test Suites: 1 failed, 1 total\nTests:       ${failed} failed, ${passed} passed, ${failed + passed} total\n`;
    expect(hiddenShare({ ok: false, tail: jest(1, 10) }, { ok: false, tail: jest(4, 7) })).toBe(0.75);
    expect(hiddenShare({ ok: false, tail: jest(1, 3) }, { ok: false, tail: 'error TS2305: no export' })).toBe(0.75);
    expect(hiddenShare({ ok: false, tail: '\x1b[2m Tests \x1b[22m 2 failed | 6 passed (8)' })).toBe(0.75);
    const cargo =
      'test result: ok. 3 passed; 0 failed; 0 ignored\ntest result: FAILED. 2 passed; 3 failed; 0 ignored\n';
    expect(hiddenShare({ ok: false, tail: cargo })).toBe(0.625);
    expect(hiddenShare({ ok: false, tail: '# pass 1\n# fail 3\n' })).toBe(0.25);
    expect(hiddenShare({ ok: true, tail: '' })).toBe(1);
    expect(hiddenShare({ ok: false, tail: 'error: could not compile' })).toBe(0);
    expect(hiddenShare({ ok: false, tail: jest(1, 7) }, { ok: false, tail: jest(1, 7) })).toBe(0);
    expect(hiddenShare(undefined)).toBeUndefined();
  });

  it('drops build info and git hooks from both sides of a judged pair', () => {
    const extra = ['tsconfig.tsbuildinfo', '.husky/pre-commit', '.changeset/blue-fox.md', 'pnpm-lock.yaml', 'bun.lock']
      .map(f => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-old\n+new\n`)
      .join('');
    const out = scrub(diff + extra);
    expect(out).not.toMatch(/tsbuildinfo|husky|changeset|pnpm-lock|bun\.lock/);
    expect(out).toContain('src/a.test.ts');
    expect(out).toContain('+// see #N from someone');
  });

  it('reads a judge reply with its tokens and cost from claude -p or an OpenAI-style completion', () => {
    const claude = {
      result: 'A is better',
      total_cost_usd: 0.25,
      usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5, output_tokens: 7 },
    };
    expect(parseBenchJudgeResponse(JSON.stringify(claude))).toEqual({
      text: 'A is better',
      tokens: { input: 10, cacheRead: 90, cacheWrite: 5, output: 7 },
      usd: 0.25,
    });
    const openai = {
      choices: [{ message: { content: 'tie' } }],
      usage: { prompt_tokens: 100, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 60 } },
    };
    expect(parseBenchJudgeResponse(openai)).toEqual({
      text: 'tie',
      tokens: { input: 40, cacheRead: 60, cacheWrite: 0, output: 3 },
    });
    expect(parseBenchJudgeResponse('plain text')).toEqual({ text: 'plain text' });
  });

  it('reads the last JSON block of a judge answer and needs a preference', () => {
    expect(
      parseBenchJudgeVerdict('x\n```json\n{"prefer":"B"}\n```\nmore\n```json\n{"prefer":"A","A":{"findings":[]}}\n```')
    ).toEqual({
      prefer: 'A',
      A: { findings: [] },
    });
    expect(parseBenchJudgeVerdict('```json\n{"prefer":"maybe"}\n```')).toBeUndefined();
    expect(parseBenchJudgeVerdict('no block')).toBeUndefined();
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
    expect(invalid({ ...red, typecheck: { ok: false } }, { ...ok, typecheck: { ok: false } })).toBeUndefined();
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
    expect(getModelMakerFromUpstreamName('luna', aliases)).toBe('openai');
    expect(getModelMakerFromUpstreamName('glm', aliases)).toBe('z-ai');
    expect(getModelMakerFromUpstreamName('claude-opus', aliases)).toBe('anthropic');
    expect(makeCrossMakerJudgePanel({ sol: 1 }, 'glm', aliases)).toEqual({ sol: 1 });
    expect(makeCrossMakerJudgePanel({ sol: 1 }, 'luna', aliases)).toEqual({ gemini: 1 });
    expect(makeCrossMakerJudgePanel({ opus: 1, sonnet: 2, sol: 2 }, 'smart', aliases)).toEqual({
      opus: 1,
      sonnet: 2,
      gemini: 2,
    });
    expect(makeCrossMakerJudgePanel({ opus: 1, sol: 2 }, 'claude-sonnet', aliases)).toEqual({ gemini: 1, sol: 2 });
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
    expect(JSON.parse(readFileSync(join(out, 'env.json'), 'utf8'))).toMatchObject({ image: 'sha256:one' });
    const moved = spawnSync(process.execPath, [cli, 'score', kase, out, '--repo', repo], {
      encoding: 'utf8',
      env: { ...env, FAKE_IMAGE_ID: 'sha256:two' },
    });
    expect(moved.stderr).toContain('image is sha256:two, but this run started with sha256:one');
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
    writeFileSync(join(out, 'demo', 'judge', 'human-v2', 'opus.0.cost.json'), JSON.stringify({ ms: 90_000, usd: 0.5 }));
    writeFileSync(
      join(out, 'demo', 'judge', 'v2-human', 'opus.0.cost.json'),
      JSON.stringify({ ms: 30_000, usd: 0.25 })
    );
    mkdirSync(join(out, 'demo', 'floor'), { recursive: true });
    writeFileSync(join(out, 'demo', 'floor', 'score.json'), JSON.stringify({ files: 0, hidden: { ok: false } }));
    mkdirSync(join(out, 'bad', 'human'), { recursive: true });
    writeFileSync(join(out, 'bad', 'valid.json'), JSON.stringify({ invalid: 'base already passes the hidden tests' }));
    const report = bench('report', out);
    expect(report).toContain('1 valid cases, 1 invalid, 0 infra arm runs.');
    expect(report).toContain('Judges: 2 calls, $0.75, 2 min.');
    expect(report).toContain('| v2 | 1 | 1 | 1 |');
    expect(report).toContain('| floor | 0 | 1 | 0 |');
    expect(report).toContain('- bad: base already passes the hidden tests');
    expect(report).not.toContain('- demo/floor: empty diff');
    expect(report).toContain('| human vs v2 | 1 | 0.75 | 0.75 to 0.75 |');
    expect(report).toContain('| v2 | 3 |');
    expect(report).toContain('## kind bug, 1 cases');
    expect(report).toContain('## issue pr-body, 1 cases');
    expect(report).toContain('## tests hidden, 1 cases');
    expect(report).toContain('Judges agree, order-consistent, on 0 of 1 case pairs.');
    expect(report).toContain('| v2 | 1 | 1 | 1 | 1 | 1 | 1 |');

    const rows = readBenchRows(out);
    expect(rows.map(r => r.point)).toEqual([
      'opencode:smart/human@unknown//out',
      'opencode:smart/v2@unknown//out',
      'opencode:smart/floor@unknown//out',
    ]);
    expect(rows[1]).toMatchObject({
      case: 'demo',
      repeat: 1,
      strata: { kind: 'bug', issue: 'pr-body', tests: 'hidden' },
      hidden: 1,
      suite: 1,
      vsHuman: { opus: 0, sonnet: 0.5 },
      findings: { critical: 0, high: 0.75 },
      tokens,
      usd: 0.25,
      usdSource: 'list-price estimate',
    });
    expect(rows[0]!.findings.high).toBe(0.25);
    expect(rows[1]).toMatchObject({ hiddenShare: 1 });
    expect(rows[2]).toMatchObject({ outcome: 'no-change', hidden: 0, vsHuman: {} });
    expect(rows[2]).not.toHaveProperty('infra');
    expect(rows[1]).not.toHaveProperty('outcome');
    const point = { harness: 'pi', model: 'luna', engine: 'abc', hubs: { v2: 'h2' }, set: 'core@1', repeat: 2 };
    writeFileSync(join(out, 'point.json'), JSON.stringify(point));
    expect(readBenchRows(out).map(r => [r.point, r.repeat])[1]).toEqual(['pi:luna/v2@abc/h2/core@1', 2]);
    writeFileSync(join(out, 'demo', 'base', 'score.json'), JSON.stringify({ ...score('base'), suite: { ok: false } }));
    expect(readBenchRows(out)[1]).not.toHaveProperty('suite');
    mkdirSync(join(out, 'nope', 'human'), { recursive: true });
    writeFileSync(join(out, 'nope', 'case.json'), JSON.stringify({ repo: 'acme/private-app' }));
    writeFileSync(join(out, 'nope', 'human', 'score.json'), '{}');
    expect(readBenchRows(out).map(r => r.case)).toContain('nope');
    process.env.BENCH_EXCLUDE = 'private-app';
    Object.assign(env, { BENCH_EXCLUDE: 'private-app' });
    expect(readBenchRows(out).map(r => r.case)).toEqual(['demo', 'demo', 'demo']);
    expect(readBenchRows(out, ['me/other'])).toEqual([]);
    expect(readBenchRows(out, ['me/demo'])).toHaveLength(3);
    expect(bench('report', out)).not.toContain('nope');
  });
});

describe('bin/bench.ts typecheck', () => {
  it('typechecks a case without hidden tests and calls it invalid when the human fails it', () => {
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

  it('keeps only the plain tools of an agent it points at pi, which takes no patterns', () => {
    const hub = tmp('hub');
    dirs.push(hub);
    mkdirSync(join(hub, 'agents'));
    const agent = "---\nharness: opencode\ntools:\n  [\n    read,\n    grep,\n    'bash(git diff*)',\n  ]\n---\n";
    writeFileSync(join(hub, 'agents', 'reviewer.md'), agent);
    repoint(hub, 'opencode:luna');
    expect(readFileSync(join(hub, 'agents', 'reviewer.md'), 'utf8')).toContain("'bash(git diff*)'");
    repoint(hub, 'pi:luna');
    expect(readFileSync(join(hub, 'agents', 'reviewer.md'), 'utf8')).toBe(
      '---\nharness: pi\ntools: [read, grep]\n---\n'
    );
  });

  it('gives an agent with no key of its own the implementor key', () => {
    const hub = tmp('hub');
    dirs.push(hub);
    mkdirSync(join(hub, 'agents'));
    for (const name of ['implementor', 'scout']) writeFileSync(join(hub, 'agents', `${name}.md`), '---\n---\n');
    writeFileSync(join(hub, 'keys.env'), 'AGENTGRAPH_PROXY_KEYS=implementor=ki,reviewer=kr\n');
    const keys = readBenchKeys(join(hub, 'keys.env'));
    repoint(hub, 'opencode:none');
    expect(keys.AGENTGRAPH_PROXY_KEYS).toBe('implementor=ki,reviewer=kr,scout=ki');
  });

  it('keeps model keys from the keys file and the shell out of process.env', () => {
    const dir = tmp('keys');
    dirs.push(dir);
    writeFileSync(join(dir, 'keys.env'), 'AGENTGRAPH_LLM_API_KEY_SCOUT=FAKE-canary-scout\n');
    process.env.AGENTGRAPH_LLM_API_KEY_REVIEWER = 'FAKE-canary-reviewer';
    const keys = readBenchKeys(join(dir, 'keys.env'));
    expect(keys).toMatchObject({
      AGENTGRAPH_LLM_API_KEY_REVIEWER: 'FAKE-canary-reviewer',
      AGENTGRAPH_PROXY_KEYS: 'reviewer=FAKE-canary-reviewer,scout=FAKE-canary-scout',
    });
    expect(JSON.stringify(process.env)).not.toContain('FAKE-canary');
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

  it('keys the floor by the engine tree too, and stamps where a reused arm came from', () => {
    const cache = tmp('cache');
    dirs.push(cache);
    process.env.BENCH_CACHE = cache;
    const c = { id: 'demo', base: 'abc', repo: 'me/demo' };
    const [a, b] = ['a', 'b'].map(tree => armSlot(c, 'floor', { point: undefined, repeat: 1, tree }));
    delete process.env.BENCH_CACHE;
    expect(a).not.toBe(b);
    mkdirSync(a!, { recursive: true });
    writeFileSync(join(a!, 'meta.json'), JSON.stringify({ ms: 5 }));
    const at = join(cache, 'out', 'floor');
    reuse(a!, at);
    expect(JSON.parse(readFileSync(join(at, 'meta.json'), 'utf8'))).toEqual({ ms: 5, reusedFrom: a });
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
      { key: 'k', event: { type: 'start', harness: 'pi', model: 'smart' } },
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
      split: { agent: 0, tools: 0, setup: 0, checks: 0, infra: 0 },
      attempts: [
        { dir: 'v2', ms: 0, sessions: 1, usd: 0.5, tokens, split: { agent: 0, tools: 0, setup: 0, checks: 0 } },
      ],
    });
  });

  it('sums usage and time over every attempt of an arm, set-aside ones included', () => {
    const root = tmp('attempts');
    dirs.push(root);
    const attempt = (dir: string, usd: number, meta?: object) => {
      mkdirSync(join(root, dir, 'data', 'run-1'), { recursive: true });
      const trace = [
        { at: '2026-10-22T10:00:00.000Z', key: 'k', event: { type: 'start', harness: 'codex', model: 'luna' } },
        { at: '2026-10-22T10:00:30.000Z', key: 'k', event: { type: 'usage', input: 10, output: 2 } },
        { at: '2026-10-22T10:00:40.000Z', key: 'k', event: { type: 'tool', name: 'bash', ms: 2000 } },
        { at: '2026-10-22T10:01:00.000Z', key: 'k', session: { usd } },
        { at: '2026-10-22T10:01:05.000Z', setup: { ms: 5000, exit: 0 } },
        { at: '2026-10-22T10:01:06.000Z', check: { check: 'test', pass: true, ms: 1000 } },
      ];
      writeFileSync(join(root, dir, 'data', 'run-1', 'trace.jsonl'), trace.map(t => JSON.stringify(t)).join('\n'));
      if (meta) writeFileSync(join(root, dir, 'meta.json'), JSON.stringify(meta));
    };
    attempt('v2', 0.5, { ms: 1000 });
    attempt('.attic/v2-2026-10-22T09-00-00-000Z', 0.25, { ms: 2000, infra: 'SandboxError: no image' });
    attempt('v2.1792493424355', 0.125);
    attempt('.attic/floor-2026-10-22T09-00-00-000Z', 9, { ms: 9 });
    const all = readArmUsageOverAttempts(join(root, 'v2'));
    expect(all).toMatchObject({ sessions: 3, usd: 0.875, ms: 69_000 });
    expect(all.tokens).toEqual({ luna: { input: 30, cacheRead: 0, cacheWrite: 0, output: 6 } });
    expect(all.split).toEqual({ agent: 180_000, tools: 6000, setup: 15_000, checks: 3000, infra: 2000 });
    expect(all.attempts.map(a => [a.dir, a.ms, a.usd, a.infra])).toEqual([
      ['v2.1792493424355', 66_000, 0.125, undefined],
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
    expect(getBenchUsageCost({ usd: 0, tokens: { flash: t } }, 'opencode', prices)).toEqual({
      usd: 0.3 + 0.006 + 0.3 + 1.2,
      usdSource: 'list price',
    });
    expect(getBenchUsageCost({ usd: 2, tokens: { flash: t } }, 'opencode', prices)).toEqual({
      usd: 2,
      usdSource: 'recorded',
    });
    expect(getBenchUsageCost({ usd: 0.5, tokens: { luna: t } }, 'opencode', prices).usdSource).toBe(
      'list-price estimate'
    );
    expect(getBenchUsageCost({ usd: 0, tokens: { luna: t } }, 'opencode', prices)).toEqual({
      usd: 0.71,
      usdSource: 'list-price estimate',
    });
    expect(getBenchUsageCost({ usd: 1 }, 'claude-sub', prices).usdSource).toBe('list-price estimate');
    expect(getBenchUsageCost({ usd: 0, tokens: { mystery: t } }, 'opencode', prices)).toEqual({
      usd: 0,
      usdSource: 'unpriced',
    });
  });
});

describe('pickBenchTestCommands', () => {
  it('turns the miner test file list into a test command per repo', () => {
    expect(pickBenchTestCommands('acme/explorer', ['src/a/[id]/x.test.ts', 'src/a/fixture.json'])).toMatchObject({
      test: expect.stringContaining("--runTestsByPath 'src/a/[id]/x.test.ts'"),
      setup: expect.stringContaining("'10.28.2'"),
    });
    expect(
      pickBenchTestCommands('acme/stacks.js', ['packages/api/tests/a.test.ts', 'packages/auth/tests/setup.js']).test
    ).toBe("(cd packages/api && npx jest --runTestsByPath 'tests/a.test.ts')");
    expect(
      pickBenchTestCommands('acme/clarinet', ['components/clarinet-deployments/tests/remap.rs', 'x/a.test.ts'])
    ).toEqual({
      toolchain: expect.stringMatching(/^export RUSTUP_TOOLCHAIN=.* && rustup toolchain install /),
      setup: expect.stringMatching(/^export RUSTUP_TOOLCHAIN=.* && cargo fetch && \(cargo test --no-run \|\| true\)$/),
      test: expect.stringMatching(/^export RUSTUP_TOOLCHAIN=.* && cargo test -p clarinet-deployments --test remap$/),
      typecheck: 'cargo check --tests',
    });
    expect(pickBenchTestCommands('acme/clarinet', ['components/clarinet-format/tests/golden/a.clar']).setup).toBe(
      pickBenchTestCommands('acme/clarinet', ['components/clarinet-deployments/tests/remap.rs']).setup
    );
    expect(pickBenchTestCommands('acme/clarinet', ['components/clarinet-format/tests/golden/a.clar']).test).toMatch(
      / && cargo test -p clarinet-format --tests$/
    );
    expect(
      pickBenchTestCommands('acme/clarinet', ['components/clarity-repl/src/analysis/coverage_tests.rs']).test
    ).toMatch(/ && cargo test -p clarity-repl --lib analysis::coverage_tests$/);
    expect(pickBenchTestCommands('acme/clarinet', ['components/clarinet-sdk/node/tests/a.test.ts'])).toMatchObject({
      setup: expect.stringContaining('build.mjs'),
      test: "(cd components/clarinet-sdk/node && npx vitest run 'tests/a.test.ts')",
    });
    expect(
      pickBenchTestCommands('acme/explorer', ['src/a/__tests__/__snapshots__/B.test.tsx.snap']).test
    ).toContain("'src/a/__tests__/B.test.tsx'");
    expect(pickBenchTestCommands('acme/stacks.js', [])).toEqual({
      hasTests: false,
      setup: 'npm ci --no-audit --no-fund --ignore-scripts',
      typecheck: 'npm run typecheck --workspaces --if-present',
    });
    expect(pickBenchTestCommands('acme/explorer', ['README.md'])).toMatchObject({
      hasTests: false,
      typecheck: expect.any(String),
    });
    expect(pickBenchTestCommands('acme/app', [])).toEqual({ hasTests: false });
  });

  it('runs one cargo command per hidden Rust file and builds the workspace tests during setup', () => {
    expect(
      pickBenchTestCommands('acme/clarity-wasm', [
        'clar2wasm/tests/wasm-generation/main.rs',
        'clar2wasm/tests/wasm-generation/equal.rs',
        'clar2wasm/tests/contracts/a.clar',
        'tests/tests/lib_tests.rs',
        'tests/benches/benchmark.rs',
      ])
    ).toEqual({
      image: 'agentgraph-sandbox:services',
      toolchain: expect.stringMatching(/^export RUSTUP_TOOLCHAIN=.* && rustup toolchain install \$RUSTUP_TOOLCHAIN /),
      setup: expect.stringMatching(
        /^export RUSTUP_TOOLCHAIN=.* && cargo fetch && \(cargo test --no-run \|\| true\) && \(\(for f in "" \$\(sed .*test-clarity-v.* clar2wasm\/Cargo.toml\); do cargo test \$\{f:\+--features \$f\} --no-run --manifest-path clar2wasm\/Cargo.toml \|\| exit 1; done\) \|\| true\)$/
      ),
      test: expect.stringMatching(
        /^export RUSTUP_TOOLCHAIN=.* && export PROPTEST_CASES=100 && \(for f in .*; do cargo test \$\{f:\+--features \$f\} --manifest-path clar2wasm\/Cargo.toml --test wasm-generation equal:: \|\| exit 1; done\) && cargo test --manifest-path tests\/Cargo.toml --test lib_tests$/
      ),
    });
    expect(pickBenchTestCommands('acme/clarity-wasm', ['clar2wasm/tests/oom-checker/main.rs']).setup).toBe(
      pickBenchTestCommands('acme/clarity-wasm', ['tests/tests/lib_tests.rs']).setup
    );
    expect(pickBenchTestCommands('stacks-network/stacks-core', ['src/vm/tests/mod.rs']).setup).toMatch(
      / && cargo fetch && \(cargo test --no-run \|\| true\)$/
    );
    expect(pickBenchTestCommands('acme/clarity-wasm', ['clar2wasm/tests/oom-checker/main.rs']).test).toMatch(
      /cargo test \$\{f:\+--features \$f\} --manifest-path clar2wasm\/Cargo.toml --test oom-checker \|\| exit 1; done\)$/
    );
    expect(
      pickBenchTestCommands('stacks-network/stacks-core', [
        'stacks-signer/src/tests/chainstate.rs',
        'src/vm/tests/mod.rs',
        'src/a.rs',
      ]).test
    ).toMatch(
      / && cargo test --manifest-path stacks-signer\/Cargo.toml --lib tests::chainstate && cargo test --lib vm::tests$/
    );
    expect(pickBenchTestCommands('stacks-network/stacks-core', ['stackslib/src/net/api/mod.rs'])).toEqual({
      hasTests: false,
    });
  });

  it('starts PostgreSQL for the API repos and runs each file under the jest config that holds it', () => {
    expect(
      pickBenchTestCommands('acme/stacks-blockchain-api', [
        'src/tests/tx-tests.ts',
        'tests/api/a.test.ts',
        'tests/utils/b.ts',
      ])
    ).toEqual({
      image: 'agentgraph-sandbox:services',
      setup:
        'npm ci --no-audit --no-fund --ignore-scripts && if [ -f client/package-lock.json ]; then (cd client && npm ci --no-audit --no-fund --ignore-scripts); fi',
      test: "services && npm run test -- --coverage=false --runTestsByPath 'src/tests/tx-tests.ts' && npm run test:api -- --coverage=false --runTestsByPath 'tests/api/a.test.ts'",
    });
    expect(
      pickBenchTestCommands('acme/stacks-blockchain-api', ['tests/utils/b.ts', 'tests/2.5/c.test.ts'])
    ).toEqual({
      hasTests: false,
    });
    expect(pickBenchTestCommands('acme/token-metadata-api', ['tests/a.test.ts'])).toMatchObject({
      image: 'agentgraph-sandbox:services',
      test: expect.stringMatching(
        /^services && export .*PGPORT=5432 .*jest --runInBand --runTestsByPath 'tests\/a\.test\.ts'; else .*node --import tsx --test/
      ),
    });
  });

  it('runs vitest, jest or node tests per package in the smaller JS repos', () => {
    expect(pickBenchTestCommands('acme/connect', ['packages/connect/tests/a.test.ts']).test).toBe(
      "(cd packages/connect && npx vitest run 'tests/a.test.ts')"
    );
    expect(pickBenchTestCommands('leather-io/workers', ['packages/x/src/a.spec.ts']).setup).toContain("'10.33.0'");
    expect(
      pickBenchTestCommands('acme/stacks-mesh-api', ['packages/api/tests/api/a.test.ts', 'packages/api/tests/h.ts'])
        .test
    ).toBe("(cd packages/api && NODE_ENV=test node --test --import tsx --test-timeout 300000 'tests/api/a.test.ts')");
    expect(pickBenchTestCommands('acme/api-toolkit', ['src/__tests__/a.test.ts']).test).toBe(
      "node_modules/.bin/jest --runInBand --runTestsByPath 'src/__tests__/a.test.ts'"
    );
    expect(
      pickBenchTestCommands('acme/clarinet', ['components/clarinet-sdk/vitest-helpers/tests/a.test.ts'])
    ).toEqual({
      setup: '(cd components/clarinet-sdk && npm ci --no-audit --no-fund --ignore-scripts)',
      test: "(cd components/clarinet-sdk && npx vitest run 'vitest-helpers/tests/a.test.ts')",
      typecheck: 'cargo check --tests',
    });
  });
});
