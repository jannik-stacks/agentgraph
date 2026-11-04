import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseBenchJudgeResponse,
  readCaseImage,
  couplings,
  getModelMakerFromUpstreamName,
  hiddenShare,
  invalid,
  orders,
  pad,
  parsePanel,
  pickBenchTestCommands,
  plant,
  readBenchKeys,
  repoint,
  readBenchSetupLabels,
  scrub,
  stats,
  makeCrossMakerJudgePanel,
  unpriced,
  parseBenchJudgeVerdict,
  whyPointUnready,
  writeArmGraph,
} from '../bin/bench.ts';
import { faked } from './fixtures.ts';
import {
  type BenchInput,
  getBenchSlot,
  getBenchUsageCost,
  readAttemptRun,
  readBenchRows,
  readLatestRunChecks,
} from '../bench/runs.ts';
import { writeImportedRun } from '../src/instance.ts';
import { git, tmp } from './kit.ts';
import { getRounded } from '../src/stats.ts';

const cli = join(import.meta.dirname, '..', 'bin', 'bench.ts');

/** A stand-in docker client that runs a score container's `sh -c` on the host, in the dir bound at `/work`. */
const hostDocker = (image = true) => {
  const bin = tmp('bin');
  writeFileSync(
    join(bin, 'docker'),
    [
      '#!/bin/sh',
      `echo "$*" >> ${join(bin, 'calls')}`,
      'case "$*" in *"printf agentgraph-command-ready"*) printf agentgraph-command-ready; exit 0;; esac',
      ...(image ? [] : ['[ "$1" = image ] && exit 1']),
      `[ ! -e ${join(bin, 'fail-pin')} ] || case "$*" in *sha256:one*) exit 1;; esac`,
      `[ "$1 $3" = "image --format" ] && { case "$*" in *sha256:one*) echo sha256:one;; *sha256:two*) echo sha256:two;; *) cat ${join(bin, 'image-id')};; esac; exit 0; }`,
      '[ "$1" = run ] || exit 0',
      'for a; do case "$a" in type=bind,src=*,dst=/work) dir=${a#type=bind,src=}; dir=${dir%,dst=/work};; esac; done',
      'while [ $# -gt 1 ] && [ "$1" != -c ]; do shift; done',
      'cd "$dir" && exec sh "$@"',
    ].join('\n')
  );
  chmodSync(join(bin, 'docker'), 0o755);
  writeFileSync(join(bin, 'image-id'), 'sha256:one');
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
    const out = scrub(diff, ['morgan']);
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
    expect(invalid({ applied: true }, { applied: true })).toMatch(/no hidden tests run/);
    expect(invalid({ applied: true }, { applied: true }, false)).toBeUndefined();
    expect(invalid({ applied: true }, ok, true)).toMatch(/no hidden tests run/);
    expect(invalid(ok, ok)).toMatch(/base already passes/);
    expect(invalid(red, { ...ok, hidden: { ok: false } })).toMatch(/human fails the hidden/);
    expect(invalid(red, { ...ok, suite: { ok: false } })).toMatch(/human fails the suite/);
    expect(invalid(red, { applied: false })).toMatch(/does not apply/);
    expect(invalid(red, { ...ok, setup: { ok: false } })).toMatch(/setup fails/);
    expect(invalid(red, { ...ok, typecheck: { ok: false } })).toMatch(/human fails the typecheck/);
    expect(invalid({ ...red, typecheck: { ok: false } }, { ...ok, typecheck: { ok: false } })).toBeUndefined();
    expect(invalid({ applied: true }, { applied: true, typecheck: { ok: false } }, false)).toMatch(
      /human fails the typecheck/
    );
    expect(invalid({ applied: true }, { applied: true, typecheck: { ok: true } }, false)).toBeUndefined();
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
});

describe('case image pins', () => {
  it('rejects a missing graph before selecting a fallback image', async () => {
    const graph = join(tmp('graph'), 'missing');
    const out = tmp('out');
    const c = { id: 'demo', dir: graph, repo: 'me/demo', base: 'a', merged: 'b', title: '', body: '' };
    await expect(readCaseImage(c, out, graph)).rejects.toThrow('case graph is missing');
    expect(existsSync(join(out, 'work/demo/image.json'))).toBe(false);
  });

  it('reads graph settings strictly before saving a pin', async () => {
    const graph = tmp('graph');
    const out = tmp('out');
    writeFileSync(join(graph, 'settings.yaml'), 'image: graph:1\nunknown: true\n');
    const c = { id: 'demo', dir: graph, repo: 'me/demo', base: 'a', merged: 'b', title: '', body: '' };
    await expect(readCaseImage(c, out, graph)).rejects.toThrow('unknown');
    expect(existsSync(join(out, 'work/demo/image.json'))).toBe(false);
  });

  it('pins separate repos and resumes by ID even after graph changes', async () => {
    const graph = tmp('graph');
    const out = tmp('out');
    writeFileSync(join(graph, 'settings.yaml'), 'image: graph:1\n');
    const c = { id: 'demo', dir: graph, repo: 'me/demo', base: 'a', merged: 'b', title: '', body: '' };
    await faked({ 'image inspect': 'sha256:one' }, async () => {
      await readCaseImage(c, out, graph);
    });
    writeFileSync(join(graph, 'settings.yaml'), 'image: graph:2\n');
    await faked(
      { 'image inspect --format {{.Id}} sha256:one': 'sha256:one', 'image inspect': 'sha256:two' },
      async log => {
        const resumed = await readCaseImage(c, out, graph);
        const second = await readCaseImage({ ...c, id: 'other', repo: 'me/other' }, out, graph);
        expect(resumed.image).toBe('sha256:one');
        expect(second.image).toBe('sha256:two');
        expect(log()).toContain('{{.Id}} sha256:one');
        expect(log()).toContain('{{.Id}} graph:2');
      }
    );
  });
});

const makeSumCase = (root: string, fields: object = {}) => {
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
  const set = join(root, 'set');
  const kase = join(set, 'cases', 'demo');
  mkdirSync(kase, { recursive: true });
  const json = { repo: 'me/demo', base, merged, title: 'Fix sum', test: 'node test/run.js', tests: ['test/run.js'] };
  writeFileSync(join(kase, 'case.json'), JSON.stringify({ ...json, ...fields }));
  writeFileSync(join(kase, 'issue.md'), '# Fix sum\n\nsum subtracts.\n');
  writeFileSync(join(kase, 'merged.diff'), git(repo, 'diff', base, merged));
  return { repo, base, merged, set, kase };
};

const addArmRun = async (set: string, repo: string, base: string, input: BenchInput, patch: string) => {
  const at = join(getBenchSlot(set, input), '1');
  mkdirSync(at, { recursive: true });
  git(at, 'init', '-q', '--bare', join(at, 'tracker', 'origin.git'));
  writeFileSync(join(at, 'change.patch'), `${patch}\n`);
  const data = join(at, 'data');
  const id = await writeImportedRun(
    { repo, tracker: join(at, 'tracker'), data },
    patch ? join(at, 'change.patch') : base,
    {
      version: 't',
      from: base,
      input,
    }
  );
  const trace = [
    { at: '2026-10-22T10:00:00.000Z', key: 'k', event: { type: 'start', harness: 'opencode', model: 'smart' } },
    { at: '2026-10-22T10:00:30.000Z', key: 'k', event: { type: 'usage', input: 100, cacheRead: 90, output: 5 } },
    { at: '2026-10-22T10:01:00.000Z', key: 'k', session: { usd: 0.25 } },
  ];
  writeFileSync(join(data, id, 'trace.jsonl'), trace.map(t => JSON.stringify(t)).join('\n'));
  const armed = { check: 'bench/arm', pass: true, ms: 0, value: { answers: 0, ms: 60_000 } };
  writeFileSync(
    join(data, id, 'checks.jsonl'),
    `${JSON.stringify({ at: '2026-10-22T10:02:00.000Z', step: 'bench', check: armed, version: 't', usd: 0, later: true })}\n`
  );
  return { at, data, id };
};

const readSlotResults = (set: string, input: BenchInput) => {
  const at = join(getBenchSlot(set, input), '1');
  const found = readAttemptRun(at)!;
  return Object.fromEntries([...readLatestRunChecks(found.data, found.run.id)].map(([k, e]) => [k, e]));
};

describe('bin/bench.ts score and judge', () => {
  it('gates a case on its reference runs and records why it is invalid', () => {
    const root = tmp('bench-invalid');
    dirs.push(root);
    const { repo, set, kase } = makeSumCase(root, { repo: 'leather-io/mono', test: undefined });
    const gate = spawnSync(process.execPath, [cli, 'score', 'v2', kase, set, '--repo', repo], {
      encoding: 'utf8',
      env: hostDocker(),
    });
    expect(gate.status, gate.stderr).toBe(0);
    expect(gate.stdout).toContain('gate demo: invalid: no test command for leather-io/mono');
    expect(gate.stdout).toContain('base hidden=not run suite=not run typecheck=not run');
    const valid = readSlotResults(set, { case: 'demo', arm: 'human', repeat: 1 })['bench/valid']!;
    expect(valid.check).toMatchObject({ pass: false, findings: expect.stringContaining('set case.test') });
    expect(valid.later).toBe(true);
    expect(readBenchRows([set])).toEqual([]);
  });

  it('scores the references and an agent run as later results, skips current ones, and judges against the human', async () => {
    const root = tmp('bench');
    dirs.push(root);
    const { repo, base, merged, set, kase } = makeSumCase(root, { kind: 'bug', flags: ['no-issue-pr-body'] });
    const missing = spawnSync(process.execPath, [cli, 'score', 'v2', kase, set, '--repo', repo], {
      encoding: 'utf8',
      env: hostDocker(false),
    });
    expect(missing.status).not.toBe(0);
    const env = hostDocker();
    const bench = (...args: string[]) => {
      const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env });
      expect(r.status, r.stderr).toBe(0);
      return r.stdout;
    };
    expect(bench('score', 'v2', kase, set, '--repo', repo)).toContain(
      'gate demo: valid: hidden tests distinguish base and human'
    );
    expect(JSON.parse(readFileSync(join(set, 'work/demo/image.json'), 'utf8'))).toEqual({ image: 'sha256:one' });
    writeFileSync(join(env.PATH.split(delimiter)[0]!, 'image-id'), 'sha256:two');
    bench('score', 'v2', kase, set, '--repo', repo);
    expect(JSON.parse(readFileSync(join(set, 'work/demo/image.json'), 'utf8'))).toEqual({ image: 'sha256:one' });
    const failPin = join(env.PATH.split(delimiter)[0]!, 'fail-pin');
    writeFileSync(failPin, '');
    const gone = spawnSync(process.execPath, [cli, 'score', 'v2', kase, set, '--repo', repo], {
      encoding: 'utf8',
      env,
    });
    expect(gone.status).not.toBe(0);
    expect(gone.stderr).toContain('sha256:one');
    rmSync(failPin);

    const v2 = { case: 'demo', arm: 'v2', repeat: 1 };
    const floor = { case: 'demo', arm: 'floor', repeat: 1 };
    await addArmRun(set, repo, base, v2, git(repo, 'diff', base, merged, '--', 'sum.js'));
    await addArmRun(set, repo, base, floor, '');
    bench('score', 'v2', kase, set, '--repo', repo);
    bench('score', 'floor', kase, set, '--repo', repo);
    const results = (input: BenchInput) =>
      Object.fromEntries(Object.entries(readSlotResults(set, input)).map(([k, e]) => [k, e.check]));
    expect(results({ case: 'demo', arm: 'base', repeat: 1 })).toMatchObject({
      'bench/setup': { pass: true, value: { applied: true, image: 'sha256:one' } },
      'bench/suite': { pass: true },
      'bench/hidden': { pass: false },
    });
    expect(results(v2)).toMatchObject({
      'bench/hidden': { pass: true, share: 1 },
      'bench/size': { value: { srcAdded: 1, overlap: 0.5 } },
    });
    expect(results({ case: 'demo', arm: 'human', repeat: 1 })).toMatchObject({
      'bench/hidden': { pass: true },
      'bench/size': { value: { testsAdded: 1, overlap: 1 } },
      'bench/valid': { pass: true },
    });
    const ends = () =>
      readFileSync(join(set, 'log.jsonl'), 'utf8')
        .split('\n')
        .filter(l => l.includes('"event":"end"'));
    const scored = ends().length;
    bench('score', 'v2', kase, set, '--repo', repo);
    expect(ends()).toHaveLength(scored);

    const bin = env.PATH.split(delimiter)[0]!;
    const verdict =
      '```json\\n{\\"prefer\\": \\"A\\", \\"A\\": {\\"findings\\": [{\\"severity\\": \\"high\\", \\"category\\": \\"tests\\", \\"text\\": \\"no test\\"}]}}\\n```';
    writeFileSync(
      join(bin, 'claude'),
      `#!/bin/sh\ncat > /dev/null\nprintf '%s' '{"result":"${verdict}","total_cost_usd":0.1}'\n`
    );
    chmodSync(join(bin, 'claude'), 0o755);
    writeFileSync(join(set, 'budget.json'), JSON.stringify({ now: 0, at: Date.now() }));
    bench('judge', 'v2', kase, set, '--judges', 'opus:2');
    bench('judge', 'v2', kase, set, '--judges', 'opus:2');
    const judged = readSlotResults(set, v2)['bench/judge']!;
    expect(judged).toMatchObject({ usd: 0.2, later: true });
    expect(judged.check.value).toMatchObject({
      vsHuman: { opus: 0.5 },
      findings: { critical: 0, high: 0.5 },
      against: { critical: 0, high: 0.5 },
    });
    expect(
      readFileSync(join(set, 'log.jsonl'), 'utf8').match(
        /"step":"judge","case":"demo","arm":"v2","judge":"opus".*"event":"start"/g
      )
    ).toHaveLength(2);

    const rows = readBenchRows([set]);
    expect(rows.map(r => r.labels.arm).toSorted()).toEqual(['base', 'floor', 'human', 'v2']);
    const row = (arm: string) => rows.find(r => r.labels.arm === arm)!;
    expect(row('v2')).toMatchObject({
      case: 'demo',
      repeat: 1,
      labels: { kind: 'bug', issue: 'pr-body', tests: 'hidden', set: 'set', 'agents-md': 'false' },
      hidden: 1,
      hiddenShare: 1,
      suite: 1,
      vsHuman: { opus: 0.5 },
      minutes: 1,
      tokens: { smart: { input: 10, cacheRead: 90, cacheWrite: 0, output: 5 } },
    });
    expect(row('v2').checkUsd).toBe(0.2);
    expect(row('v2')).not.toHaveProperty('outcome');
    expect(row('floor')).toMatchObject({ outcome: 'no-change', hidden: 0, vsHuman: {} });
    expect(row('floor')).not.toHaveProperty('infra');

    writeFileSync(join(set, 'work/demo/image.json'), JSON.stringify({ image: 'sha256:two' }));
    bench('score', 'v2', kase, set, '--repo', repo);
    expect(results(v2)['bench/setup']!.value).toMatchObject({ image: 'sha256:two' });
    expect(results({ case: 'demo', arm: 'human', repeat: 1 })['bench/setup']!.value).toMatchObject({
      image: 'sha256:two',
    });
  });

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
    const set = join(root, 'set');
    const kase = join(set, 'cases', 'demo');
    mkdirSync(kase, { recursive: true });
    const typecheck = 'grep -q ok a.js';
    writeFileSync(
      join(kase, 'case.json'),
      JSON.stringify({ repo: 'me/demo', base, merged, bucket: 'no-tests', typecheck })
    );
    writeFileSync(join(kase, 'issue.md'), '# Change a\n\nChange it.\n');
    writeFileSync(join(kase, 'merged.diff'), git(repo, 'diff', base, merged));
    const r = spawnSync(process.execPath, [cli, 'score', 'human', kase, set, '--repo', repo], {
      encoding: 'utf8',
      env: hostDocker(),
    });
    expect(r.status, r.stderr).toBe(0);
    const results = (arm: string) =>
      Object.fromEntries(
        Object.entries(readSlotResults(set, { case: 'demo', arm, repeat: 1 })).map(([k, e]) => [k, e.check])
      );
    expect(results('base')).toMatchObject({
      'bench/typecheck': { pass: true },
      'bench/hidden': { na: true, findings: 'case disables hidden tests' },
    });
    expect(results('human')).toMatchObject({
      'bench/typecheck': { pass: false },
      'bench/valid': { pass: false, findings: 'the human fails the typecheck' },
    });
  });
});

describe('arm graphs', () => {
  it.each([
    ['v2', 'workflows/issue.md'],
    ['floor', 'workflows/issue.md'],
  ] as const)('pins the case image into the %s graph', (arm, workflow) => {
    const at = tmp('arm-graph');
    dirs.push(at);
    const c = {
      id: 'demo',
      dir: at,
      repo: 'me/demo',
      base: 'a',
      merged: 'b',
      title: '',
      body: '',
      image: 'sha256:one',
    };
    const graph = writeArmGraph(c, arm, at);
    expect(readFileSync(join(graph, 'settings.yaml'), 'utf8')).toContain('image: sha256:one');
    expect(readFileSync(join(graph, workflow), 'utf8')).toBe(
      readFileSync(
        join(import.meta.dirname, '..', arm === 'floor' ? 'bench/floor' : 'examples/bench', workflow),
        'utf8'
      ).replace(/^ {4}checks: \[tests\]\n/m, '')
    );
  });
});

describe('bench labels', () => {
  it('reads setup at the base commit without inspecting or changing the working tree', () => {
    const repo = tmp('labels');
    dirs.push(repo);
    git(repo, 'init', '-q');
    mkdirSync(join(repo, '.agents/skills/review'), { recursive: true });
    writeFileSync(join(repo, 'AGENTS.md'), 'rules');
    writeFileSync(join(repo, '.agents/skills/review/SKILL.md'), 'review');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');
    rmSync(join(repo, 'AGENTS.md'));
    writeFileSync(join(repo, 'CLAUDE.md'), 'uncommitted');
    const status = git(repo, 'status', '--porcelain');
    expect(readBenchSetupLabels(repo, base)).toEqual({ 'agents-md': 'true', 'claude-md': 'false', skills: 'true' });
    expect(git(repo, 'status', '--porcelain')).toBe(status);
  });
  it('counts a tracked skills symlink as present', () => {
    const repo = tmp('labels');
    dirs.push(repo);
    git(repo, 'init', '-q');
    mkdirSync(join(repo, '.cursor'), { recursive: true });
    symlinkSync('../rules', join(repo, '.cursor/rules'));
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'base');
    expect(readBenchSetupLabels(repo, 'HEAD')).toEqual({ 'agents-md': 'false', 'claude-md': 'false', skills: 'true' });
  });
});

describe('points', () => {
  it('rewrites only the harness and model of each agent front matter', () => {
    const graph = tmp('graph');
    dirs.push(graph);
    mkdirSync(join(graph, 'agents'));
    const agent = '---\nharness: opencode\nmodel: smart\n---\nmodel: keep this line\n';
    writeFileSync(join(graph, 'agents', 'implementor.md'), agent);
    repoint(graph, 'pi:luna');
    expect(readFileSync(join(graph, 'agents', 'implementor.md'), 'utf8')).toBe(
      '---\nharness: pi\nmodel: luna\n---\nmodel: keep this line\n'
    );
  });

  it('keeps only the plain tools of an agent it points at pi, which takes no patterns', () => {
    const graph = tmp('graph');
    dirs.push(graph);
    mkdirSync(join(graph, 'agents'));
    const agent = "---\nharness: opencode\ntools:\n  [\n    read,\n    grep,\n    'bash(git diff*)',\n  ]\n---\n";
    writeFileSync(join(graph, 'agents', 'reviewer.md'), agent);
    repoint(graph, 'opencode:luna');
    expect(readFileSync(join(graph, 'agents', 'reviewer.md'), 'utf8')).toContain("'bash(git diff*)'");
    repoint(graph, 'pi:luna');
    expect(readFileSync(join(graph, 'agents', 'reviewer.md'), 'utf8')).toBe(
      '---\nharness: pi\ntools: [read, grep]\n---\n'
    );
  });

  it('gives an agent with no key of its own the implementor key', () => {
    const graph = tmp('graph');
    dirs.push(graph);
    mkdirSync(join(graph, 'agents'));
    for (const name of ['implementor', 'scout']) writeFileSync(join(graph, 'agents', `${name}.md`), '---\n---\n');
    writeFileSync(join(graph, 'keys.env'), 'AGENTGRAPH_PROXY_KEYS=implementor=ki,reviewer=kr\n');
    const keys = readBenchKeys(join(graph, 'keys.env'));
    repoint(graph, 'opencode:none');
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
});

describe('prices', () => {
  it('names the models of an arm that have no list price, so a bench stops before it spends', () => {
    const graph = tmp('graph');
    dirs.push(graph);
    mkdirSync(join(graph, 'agents'));
    writeFileSync(join(graph, 'agents', 'implementor.md'), '---\nharness: opencode\nmodel: smart\n---\n');
    writeFileSync(join(graph, 'agents', 'scout.md'), '---\nharness: opencode\nmodel: mystery\n---\n');
    expect(unpriced('v2', graph, undefined)).toEqual(['mystery']);
    expect(unpriced('v2', graph, 'opencode:deepseek-flash')).toEqual([]);
    expect(unpriced('v2', graph, 'opencode:nope')).toEqual(['nope']);
    expect(unpriced('floor', graph, undefined)).toEqual([]);
  });

  it('names a point that has no list price or that the proxy refuses with the key its agents get', async () => {
    const at = tmp('keys');
    dirs.push(at);
    const file = join(at, 'keys.env');
    writeFileSync(file, 'AGENTGRAPH_LLM_API_KEY_IMPLEMENTOR=impl-key\n');
    readBenchKeys(file);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not allowed', { status: 403 }));
    try {
      expect(await whyPointUnready('opencode:nope')).toBe('opencode:nope: no list price for nope');
      expect(fetch).not.toHaveBeenCalled();
      expect(await whyPointUnready('codex:luna')).toBe('codex:luna: the proxy answered 403: not allowed');
      expect(fetch.mock.calls[0]![1]!.headers).toMatchObject({ authorization: 'Bearer impl-key' });
    } finally {
      fetch.mockRestore();
    }
  });

  it('sends every queued point the proxy key the shell gave once the keys are read', async () => {
    const at = tmp('keys');
    dirs.push(at);
    const file = join(at, 'keys.env');
    writeFileSync(file, '');
    process.env.AGENTGRAPH_PROXY_KEYS = 'implementor=FAKE-shell-key';
    readBenchKeys(file);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('ok'));
    try {
      expect(await Promise.all(['codex:luna', 'opencode:luna'].map(whyPointUnready))).toEqual([undefined, undefined]);
      expect(fetch.mock.calls.map(call => (call[1]!.headers as Record<string, string>).authorization)).toEqual([
        'Bearer FAKE-shell-key',
        'Bearer FAKE-shell-key',
      ]);
    } finally {
      fetch.mockRestore();
    }
  });

  it('prices tokens at list price, with cache priced as input too, and names the models it cannot price', () => {
    const prices = {
      aliases: { flash: 'openrouter/deepseek/deepseek-v4.1-flash' },
      table: {
        'deepseek-v4.1-flash': {
          input_cost_per_token: 0.3e-6,
          cache_read_input_token_cost: 0.006e-6,
          output_cost_per_token: 1.2e-6,
        },
      },
    };
    const t = { input: 1e6, cacheRead: 1e6, cacheWrite: 1e6, output: 1e6 };
    expect(getBenchUsageCost({ usd: 2, tokens: { flash: t } }, prices)).toEqual({
      usd: getRounded(0.3 + 0.006 + 0.3 + 1.2),
      usdUncached: getRounded(0.3 * 3 + 1.2),
    });
    expect(getBenchUsageCost({ usd: 1 }, prices)).toEqual({ usd: 1, usdUncached: 1 });
    expect(getBenchUsageCost({ tokens: { flash: t, mystery: t } }, prices)).toMatchObject({ unpriced: ['mystery'] });
  });
});

describe('pickBenchTestCommands', () => {
  it.each(
    [
      'leather-io/mono',
      'acme/explorer',
      'acme/stacks.js',
      'acme/clarinet',
      'acme/stacks-core',
      'acme/clarity-wasm',
      'acme/stacks-blockchain-api',
      'acme/token-metadata-api',
      'acme/api-toolkit',
      'acme/connect',
      'acme/workers',
      'acme/stacks-mesh-api',
    ].flatMap(repo =>
      [[], ['README.md'], ['tests/a.test.ts'], ['tests/a.rs'], ['tests/fixture.json']].flatMap(files =>
        [{}, { hasTests: false }, { hasTests: true }, { test: 'custom test' }, { suite: 'custom suite' }].map(
          fields => ({ repo, files, fields })
        )
      )
    )
  )('runs hidden tests or explains their absence: $repo $files $fields', ({ repo, files, fields }) => {
    const commands = pickBenchTestCommands(repo, files, fields);
    expect(Boolean(commands.test && commands.hasTests !== false) || Boolean(commands.why)).toBe(true);
    expect(commands.hasTests === false && !commands.why).toBe(false);
  });

  it.each([
    { fields: { test: 'custom test' }, expected: { test: 'custom test' } },
    {
      fields: { suite: 'custom suite', setup: 'custom setup', typecheck: 'custom types', test: 'custom test' },
      expected: { suite: 'custom suite', setup: 'custom setup', typecheck: 'custom types', test: 'custom test' },
    },
    { fields: { hasTests: false }, expected: { hasTests: false, why: 'case disables hidden tests' } },
  ])('honors case commands: $fields', ({ fields, expected }) => {
    expect(pickBenchTestCommands('leather-io/mono', ['tests/a.test.ts'], fields)).toMatchObject(expected);
    expect(pickBenchTestCommands('acme/explorer', ['tests/a.test.ts'], fields)).toMatchObject(expected);
  });

  it.each(['leather-io/mono', 'acme/clarinet', 'acme/stacks-blockchain-api'])(
    'rejects unsupported test files in %s',
    repo => {
      expect(pickBenchTestCommands(repo, ['other/unknown.test.ts'])).toMatchObject({
        why: expect.stringContaining('no test command'),
      });
      expect(pickBenchTestCommands(repo, ['other/unknown.test.ts']).hasTests).not.toBe(false);
    }
  );

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
    expect(pickBenchTestCommands('acme/explorer', ['src/a/__tests__/__snapshots__/B.test.tsx.snap']).test).toContain(
      "'src/a/__tests__/B.test.tsx'"
    );
    expect(pickBenchTestCommands('acme/stacks.js', [])).toEqual({
      hasTests: false,
      why: 'case touches no test files',
      setup: 'npm ci --no-audit --no-fund --ignore-scripts',
      typecheck: 'npm run typecheck --workspaces',
    });
    expect(pickBenchTestCommands('acme/explorer', ['README.md'])).toMatchObject({
      hasTests: false,
      typecheck: expect.any(String),
    });
    expect(pickBenchTestCommands('acme/app', [])).toMatchObject({ hasTests: false, why: 'case touches no test files' });
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
      why: 'case touches no test files',
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
    expect(pickBenchTestCommands('acme/stacks-blockchain-api', ['tests/utils/b.ts', 'tests/2.5/c.test.ts'])).toEqual({
      why: expect.stringContaining('no test command'),
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
    expect(pickBenchTestCommands('acme/clarinet', ['components/clarinet-sdk/vitest-helpers/tests/a.test.ts'])).toEqual({
      setup: '(cd components/clarinet-sdk && npm ci --no-audit --no-fund --ignore-scripts)',
      test: "(cd components/clarinet-sdk && npx vitest run 'vitest-helpers/tests/a.test.ts')",
      typecheck: 'cargo check --tests',
    });
  });
});
