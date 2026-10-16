import { chmodSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { change, git, runScript, temp, write } from './kit.ts';
import { Proposal } from '../src/outputs.ts';

const scripts = resolve(import.meta.dirname, '../examples/bothub/scripts');
const modules = resolve(import.meta.dirname, '../node_modules');

/** Links bothub's own dependencies into a repository, the way the hub links them into a worktree. */
const withModules = <T extends { dir: string }>(repo: T) => {
  symlinkSync(modules, join(repo.dir, 'node_modules'));
  return repo;
};

const run = (
  script: string,
  repo: { dir: string; base: string },
  args: string[] = [],
  env: Record<string, string> = {}
) => runScript(join(scripts, script), repo, args, { PATH: `${modules}/.bin:${process.env.PATH}`, ...env });

const findings = (out: string) => out.split('\n').slice(0, -1);

const noBrief = 'test-guards: no triage brief found for this run, so no criterion tests to look for';
const guardsOk = { ok: true, out: `${noBrief}\ntest-guards: ok` };
/** Runs test-guards with an empty hub, so the criteria part finds no brief unless `env` points at one. */
const guards = (repo: { dir: string; base: string }, env: Record<string, string> = {}) => {
  const { ok, out } = run('test-guards.mjs', repo, [], { BOTHUB_HUB: temp('empty'), ...env });
  return { ok, out, found: findings(out).filter(line => line !== noBrief) };
};
const items = (out: string) => (out ? out.split('\n').map(line => JSON.parse(line) as Record<string, unknown>) : []);

const adder = 'export const add = (a: number, b: number) => a + b;\n';
const clamped = 'export const add = (a: number, b: number) => Math.max(0, a + b);\n';
const addTest = (...tests: string[]) =>
  [
    "import { expect, it } from 'vitest';",
    "import { add } from '../src/add.ts';",
    '',
    "it('adds two numbers', () => expect(add(1, 2)).toBe(3));",
    ...tests,
    '',
  ].join('\n');

describe('test-guards: new tests bite', () => {
  it('fails a new test that passes on the base code, and leaves the worktree alone', () => {
    const repo = withModules(
      change(
        { 'src/add.ts': adder, 'tests/add.test.ts': addTest() },
        {
          'src/add.ts': clamped,
          'tests/add.test.ts': addTest(
            "it('adds a negative and a positive', () => expect(add(-1, 2)).toBe(1));",
            "it('clamps a negative sum to zero', () => expect(add(-3, 1)).toBe(0));",
            "it('still adds two positives', () => expect(add(2, 2)).toBe(4));"
          ),
        }
      )
    );
    const status = git(repo.dir, 'status', '--porcelain');
    const { ok, found } = guards(repo);
    expect(ok).toBe(false);
    expect(found).toEqual([
      "tests/add.test.ts:5: 'adds a negative and a positive' passes on the base code with the change's new files added, so it would not catch the change to existing code being reverted",
    ]);
    expect(git(repo.dir, 'status', '--porcelain')).toBe(status);
  });

  it('passes when every new test fails on the base code', () => {
    const repo = withModules(
      change(
        { 'src/add.ts': adder, 'tests/add.test.ts': addTest() },
        {
          'src/add.ts': clamped,
          'tests/add.test.ts': addTest("it('clamps a negative sum to zero', () => expect(add(-3, 1)).toBe(0));"),
        }
      )
    );
    expect(guards(repo)).toMatchObject(guardsOk);
  });

  it('runs the base with the new files, so a test of a new module alone does not bite', () => {
    const subTest =
      "import { expect, it } from 'vitest';\nimport { sub } from '../src/sub.ts';\nit('subtracts', () => expect(sub(3, 1)).toBe(2));\n";
    const repo = withModules(
      change(
        { 'src/add.ts': adder },
        { 'src/sub.ts': 'export const sub = (a: number, b: number) => a - b;\n', 'tests/sub.test.ts': subTest }
      )
    );
    expect(guards(repo).found).toEqual([
      "tests/sub.test.ts:3: 'subtracts' passes on the base code with the change's new files added, so it would not catch the change to existing code being reverted",
    ]);
  });

  it('passes a test through an existing caller that a new module changes', () => {
    const repo = withModules(
      change(
        { 'src/add.ts': adder, 'tests/add.test.ts': addTest() },
        {
          'src/clamp.ts': 'export const clamp = (n: number) => Math.max(0, n);\n',
          'src/add.ts':
            "import { clamp } from './clamp.ts';\nexport const add = (a: number, b: number) => clamp(a + b);\n",
          'tests/add.test.ts': addTest("it('clamps a negative sum to zero', () => expect(add(-3, 1)).toBe(0));"),
        }
      )
    );
    expect(guards(repo)).toMatchObject(guardsOk);
  });

  it('has nothing to bite when only tests change', () => {
    const repo = change({ 'tests/a.test.ts': '' }, { 'tests/a.test.ts': "it('x', () => {});\n" });
    expect(guards(repo)).toMatchObject(guardsOk);
  });
});

describe('test-guards: the suite stays whole', () => {
  const suite = [
    "describe('a', () => {",
    "  it('one', () => { expect(1).toBe(1); expect(2).toBe(2); });",
    "  it('two', () => expect(2).toBe(2));",
    '});',
    '',
  ].join('\n');

  it('fails deleted, fewer, skipped, focused and slowed tests and setup edits', () => {
    const repo = change(
      {
        'tests/a.test.ts': suite,
        'tests/b.test.ts': suite,
        'tests/c.test.ts': suite,
        'tests/gone.test.ts': suite,
        'tests/setup/global.ts': 'export default () => {};\n',
      },
      {
        'tests/a.test.ts': "describe('a', () => {\n  it('one', () => { expect(1).toBe(1); });\n});\n",
        'tests/b.test.ts': `${suite}it.only('three', () => expect(3).toBe(3));\nit.skip('four', () => {});\n`,
        'tests/c.test.ts': `${suite}it('slow', { timeout: 30_000 }, () => expect(1).toBe(1));\n`,
        'tests/setup/global.ts': 'export default () => { process.exitCode = 0; };\n',
      },
      ['tests/gone.test.ts']
    );
    const { ok, found } = guards(repo);
    expect(ok).toBe(false);
    expect(found.sort()).toEqual([
      'tests/a.test.ts: 1 fewer tests than the base (2 to 1)',
      'tests/a.test.ts: 2 fewer expect( calls than the base (3 to 1)',
      'tests/b.test.ts:5: an added .skip, .only or .todo',
      'tests/b.test.ts:6: an added .skip, .only or .todo',
      'tests/c.test.ts:5: a test timeout of 30000 ms, above the 5000 ms default',
      'tests/gone.test.ts: deletes a test file with 2 tests',
      'tests/setup/global.ts: edits the global test setup',
    ]);
  });

  it('passes added tests, short timeouts, e2e timeouts, process timeouts and skips on a real condition', () => {
    const repo = change(
      { 'tests/a.test.ts': suite },
      {
        'tests/a.test.ts': [
          suite,
          "it('three', { timeout: 2000 }, () => expect(3).toBe(3));",
          "describe.skipIf(process.env.LIVE !== '1')('live', () => {",
          "  it('runs', () => execFileSync('docker', ['info'], { timeout: 10_000 }));",
          '});',
          "const fixture = { 'b.test.ts': `it.only('x', { timeout: 30_000 }, () => {});` };",
          '',
        ].join('\n'),
        'tests/d.e2e.test.ts': `${suite}it('boots', { timeout: 120_000 }, () => expect(1).toBe(1));\n`,
      }
    );
    expect(guards(repo)).toMatchObject(guardsOk);
  });
});

describe('test-guards: tests assert outside loops and branches', () => {
  const OLD_LOOP = ["it('old', () => {", '  for (const n of [1, 2]) expect(n).toBeTruthy();', '});', ''].join('\n');

  it('fails added loops of expect( calls, loops nested in them and expect( under an if', () => {
    const repo = change(
      { 'tests/a.test.ts': OLD_LOOP },
      {
        'tests/a.test.ts': [
          OLD_LOOP,
          "it('reads every example', () => {",
          "  for (const [example, names] of [['hub', ['issue']]] as const) {",
          '    for (const name of names) {',
          "      if (name === 'merge') expect(example).toBe('hub');",
          '      else expect(name).toBe(example);',
          '    }',
          '  }',
          '});',
          '',
        ].join('\n'),
      }
    );
    const { ok, found } = guards(repo);
    expect(ok).toBe(false);
    expect(found).toEqual([
      'tests/a.test.ts:6: a loop of expect( calls inside a test; give each case an it.each row from an upcased const array, or collect the results and assert once after the loop',
      'tests/a.test.ts:7: a loop nested in a loop of expect( calls; flatten the cases into one it.each table',
      'tests/a.test.ts:8: an expect( under an if or else; give each case its own test that asserts unconditionally',
      'tests/a.test.ts:9: an expect( under an if or else; give each case its own test that asserts unconditionally',
    ]);
  });

  it('passes it.each tables, setup loops, an assertion after a loop and loops the base already had', () => {
    const repo = change(
      { 'tests/a.test.ts': OLD_LOOP },
      {
        'tests/a.test.ts': [
          OLD_LOOP,
          'const NAMES = [',
          "  ['issue', 1],",
          "  ['merge', 2],",
          '];',
          "it.each(NAMES)('counts %s', (name, n) => expect(name.length).toBeGreaterThan(n));",
          "it('collects then asserts', () => {",
          '  const seen: number[] = [];',
          '  for (const n of [1, 2]) {',
          '    if (n > 1) seen.push(n);',
          '  }',
          '  expect(seen).toEqual([2]);',
          '});',
          "it('throws on a missing row', () => {",
          '  const row = NAMES.find(([name]) => name === "issue");',
          "  if (!row) throw new Error('missing');",
          '  expect(row[1]).toBe(1);',
          '});',
          '',
        ].join('\n'),
      }
    );
    expect(guards(repo)).toMatchObject(guardsOk);
  });
});

describe('coverage', () => {
  const branchy = ['export const sign = (n: number) => {', '  if (n < 0) return -1;', '  return 1;', '};', ''].join(
    '\n'
  );
  const signTest = (...cases: string[]) =>
    ["import { expect, it } from 'vitest';", "import { sign } from '../src/sign.ts';", ...cases, ''].join('\n');

  it('fails added lines no test runs', () => {
    const repo = withModules(
      change(
        {
          'src/sign.ts': 'export const sign = (n: number) => 1;\n',
          'tests/sign.test.ts': signTest("it('is one for positives', () => expect(sign(2)).toBe(1));"),
        },
        { 'src/sign.ts': branchy }
      )
    );
    expect(run('coverage.mjs', repo, ['src/'])).toEqual({
      ok: false,
      out: 'src/sign.ts:2: added code no test runs\ncoverage: 1 finding',
    });
  });

  it('fails a failing related test', () => {
    const repo = withModules(
      change(
        {
          'src/sign.ts': 'export const sign = (n: number) => 1;\n',
          'tests/sign.test.ts': signTest("it('is one for positives', () => expect(sign(2)).toBe(1));"),
        },
        {
          'src/sign.ts': 'export const sign = (n: number) => 0 + 1;\n',
          'tests/sign.test.ts': signTest("it('is one for positives', () => expect(sign(2)).toBe(2));"),
        }
      )
    );
    const { ok, out } = run('coverage.mjs', repo, ['src/']);
    expect(ok).toBe(false);
    expect(out).toContain('the related tests failed');
  });

  it('leaves old untested code under the whole-file thresholds alone', () => {
    const old = ['export const unused = (n: number) => {', '  if (n > 1) return n * 2;', '  return n;', '};', ''].join(
      '\n'
    );
    const repo = withModules(
      change(
        {
          'vitest.config.mjs': 'export default { test: { coverage: { thresholds: { lines: 95 } } } };\n',
          'src/sign.ts': `${old}export const sign = (n: number) => 1;\n`,
          'tests/sign.test.ts': signTest("it('is one for positives', () => expect(sign(2)).toBe(1));"),
        },
        { 'src/sign.ts': `${old}export const sign = (n: number) => 2 - 1;\n` }
      )
    );
    expect(run('coverage.mjs', repo, ['src/'])).toEqual({ ok: true, out: 'coverage: ok' });
  });

  it('passes when the related tests run every added line', () => {
    const repo = withModules(
      change(
        {
          'src/sign.ts': 'export const sign = (n: number) => 1;\n',
          'tests/sign.test.ts': signTest("it('is one for positives', () => expect(sign(2)).toBe(1));"),
        },
        {
          'src/sign.ts': branchy,
          'tests/sign.test.ts': signTest(
            "it('is one for positives', () => expect(sign(2)).toBe(1));",
            "it('is minus one for negatives', () => expect(sign(-2)).toBe(-1));"
          ),
        }
      )
    );
    expect(run('coverage.mjs', repo, ['src/'])).toEqual({ ok: true, out: 'coverage: ok' });
  });
});

describe('scripts that run vitest', () => {
  /** A vitest that fails without HOME, as the real one does for a sandbox user with no passwd entry. */
  const needsHome = [
    '#!/bin/sh',
    '[ -n "$HOME" ] || exit 1',
    'for a; do case "$a" in --outputFile=*) echo \'{"testResults":[]}\' > "${a#--outputFile=}";; esac; done',
    '',
  ].join('\n');
  const withStub = (repo: { dir: string; base: string }) => {
    write(repo.dir, { 'node_modules/.bin/vitest': needsHome });
    chmodSync(join(repo.dir, 'node_modules/.bin/vitest'), 0o755);
    return repo;
  };
  const changed = () =>
    withStub(
      change(
        { 'src/add.ts': adder, 'tests/add.test.ts': addTest() },
        { 'src/add.ts': clamped, 'tests/add.test.ts': addTest("it('clamps', () => expect(add(-3, 1)).toBe(0));") }
      )
    );

  it('gives vitest a HOME when the caller has none', () => {
    expect(guards(changed())).toMatchObject(guardsOk);
    expect(run('coverage.mjs', changed(), ['src/'])).toEqual({ ok: true, out: 'coverage: ok' });
  });
});

describe('tests', () => {
  const suite = (...tests: string[]) =>
    withModules(change({ 'tests/a.test.ts': ["import { expect, it } from 'vitest';", ...tests, ''].join('\n') }));

  it('passes in one line', () => {
    expect(run('tests.mjs', suite("it('adds', () => expect(1 + 1).toBe(2));"))).toEqual({
      ok: true,
      out: 'tests: 1 passed',
    });
  });

  it('names the criterion tests a passing run skipped', () => {
    const repo = suite(
      "it('replays a label added while stopped', () => expect(1).toBe(1));",
      "it.skipIf(!process.env.DOCKER)('replays a label re-added by hand', () => expect(1).toBe(1));",
      "it.skip('another skipped test', () => expect(1).toBe(1));"
    );
    write(repo.dir, { 'brief.md': brief });
    expect(run('tests.mjs', repo, [], { BOTHUB_BRIEF: join(repo.dir, 'brief.md') })).toEqual({
      ok: true,
      out: "tests: 1 passed; criterion tests skipped: 'replays a label re-added by hand'",
    });
  });

  it('fails a passing suite whose output reports a module that could not load, and lists those lines', () => {
    const loads =
      "it('loads', () => { console.error('could not load /work/src/a.ts: [PARSE_ERROR] Unexpected token'); });";
    expect(run('tests.mjs', suite(loads))).toEqual({
      ok: false,
      out: 'could not load /work/src/a.ts: [PARSE_ERROR] Unexpected token\ntests: 1 passed, but the output reports a module that could not load',
    });
  });

  it('runs the suite under a symlinked temp dir, so a resolved path never matches an unresolved root', () => {
    const repo = suite(
      "import { realpathSync } from 'node:fs';",
      "import { tmpdir } from 'node:os';",
      "it('resolves the temp dir to itself', () => expect(realpathSync(tmpdir())).toBe(tmpdir()));"
    );
    const { ok, out } = run('tests.mjs', repo);
    expect(ok).toBe(false);
    expect(out).toContain('FAIL tests/a.test.ts > resolves the temp dir to itself');
  });

  it('names the failing tests first when the error log runs long', () => {
    const repo = suite(
      "it('adds', () => expect(1 + 1).toBe(2));",
      ...Array.from({ length: 30 }, (_, i) => `it('breaks ${i}', () => expect('x'.repeat(4000)).toEqual({ n: ${i} }));`)
    );
    const { ok, out } = run('tests.mjs', repo);
    expect(ok).toBe(false);
    expect(out.length).toBeLessThan(8192);
    const names = out.split('\n').slice(0, 30);
    expect(names.every(line => line.startsWith('FAIL tests/a.test.ts > breaks '))).toBe(true);
    expect(names[29]).toContain('breaks 29: AssertionError');
    expect(out).toMatch(/Tests {2}30 failed \| 1 passed \(31\)\n[^]*\n\ntests: 30 failed$/);
  });
});

describe('old-tests', () => {
  const negative = (title: string, sum: number) => addTest(`it('${title}', () => expect(add(-3, 1)).toBe(${sum}));`);
  const edited = (title: string) =>
    withModules(
      change(
        { 'src/add.ts': adder, 'tests/add.test.ts': negative(title, -2) },
        { 'src/add.ts': clamped, 'tests/add.test.ts': negative(title, 0), 'tests/new.test.ts': negative('new', -2) }
      )
    );

  it('names an old test the change edited to pass, and leaves the worktree alone', () => {
    const repo = edited('adds a negative sum');
    const status = git(repo.dir, 'status', '--porcelain');
    expect(run('old-tests.mjs', repo, [], { BOTHUB_HUB: temp('empty') })).toEqual({
      ok: false,
      out: "tests/add.test.ts: the base's 'adds a negative sum' fails against the change: AssertionError: expected +0 to be -2 // Object.is equality\nold-tests: 1 finding",
    });
    expect(git(repo.dir, 'status', '--porcelain')).toBe(status);
  });

  it('leaves out the criterion tests of the brief', () => {
    const repo = edited('replays a label added while stopped');
    write(repo.dir, { 'brief.md': brief });
    expect(run('old-tests.mjs', repo, [], { BOTHUB_BRIEF: join(repo.dir, 'brief.md') })).toEqual({
      ok: true,
      out: 'old-tests: ok',
    });
  });
});

describe('fast', () => {
  it('runs each check with its own command and fails only on a finding of a block check', () => {
    const hub = temp('fast-hub');
    const check = (run: string, mode: string) => `---\nrun: ${run}\nmode: ${mode}\n---\n`;
    write(hub, {
      'checks/clean.md': check('echo "clean: ok"', 'block'),
      'checks/warned.md': check('echo found; exit 1', 'warn'),
      'checks/held.md': check('echo "held: $BOTHUB_BASE"; exit 1', 'block'),
    });
    const repo = change({ 'a.txt': '' });
    expect(run('fast.mjs', repo, ['clean', 'warned'], { BOTHUB_HUB: hub })).toEqual({
      ok: true,
      out: 'clean: ok\nfound\nwarned: the findings above are warn',
    });
    expect(run('fast.mjs', repo, ['held'], { BOTHUB_HUB: hub })).toEqual({
      ok: false,
      out: `held: ${repo.base}\nheld: the findings above are block`,
    });
  });

  it('runs only script checks of the hub', async () => {
    const { fast } = await import(join(scripts, 'fast.mjs'));
    const script = (name: string) => {
      const text = readFileSync(join(scripts, `../checks/${name}.md`), 'utf8');
      return /^run: /m.test(text) && !/^agent: /m.test(text);
    };
    expect(fast.filter((name: string) => !script(name))).toEqual([]);
  });
});

describe('lint on added lines', () => {
  const config = { '.oxlintrc.json': '{ "rules": { "no-debugger": "error" } }\n' };

  it('ignores errors on lines the change did not add', () => {
    const repo = change(
      { ...config, 'src/a.ts': 'debugger;\nexport const a = 1;\n' },
      { 'src/a.ts': 'debugger;\nexport const a = 1;\nexport const b = 2;\n' }
    );
    expect(run('lint.mjs', repo)).toEqual({ ok: true, out: 'lint: ok' });
  });

  it('fails errors on added lines, including the stricter suspicious rules', () => {
    const repo = change(
      { ...config, 'src/a.ts': 'export const a = 1;\n' },
      {
        'src/a.ts': [
          'export const a = 1;',
          'debugger;',
          'export const f = (g: () => void) => {',
          '  try {',
          '    g();',
          '  } catch (e) {',
          '    throw new Error(String(e));',
          '  }',
          '};',
          '',
        ].join('\n'),
      }
    );
    const { ok, out } = run('lint.mjs', repo);
    expect(ok).toBe(false);
    expect(findings(out)).toEqual([
      expect.stringMatching(/^src\/a\.ts:2: eslint\(no-debugger\)/),
      expect.stringMatching(/^src\/a\.ts:7: eslint\(preserve-caught-error\)/),
    ]);
  });
});

describe('safety secret scan', () => {
  it('fails random-looking tokens, bearer tokens and URLs with credentials', () => {
    const repo = change(
      { 'src/a.ts': 'export const a = 1;\n' },
      {
        'src/a.ts': [
          'export const a = 1;',
          "const key = 'q7Vb2LmX9pRt4WzK8sYc3NdH6fJg1QaE';",
          "const auth = { authorization: 'Bearer abcdefghijklmnopqrstuvwxyz012345' };",
          "const db = 'postgres://admin:hunter22@db.internal:5432/app';",
          '',
        ].join('\n'),
      }
    );
    const { ok, out } = run('safety.mjs', repo, ['src/']);
    expect(ok).toBe(false);
    expect(findings(out)).toEqual([
      'src/a.ts:2: adds a high-entropy token',
      'src/a.ts:3: adds a bearer token',
      'src/a.ts:4: adds a URL with credentials',
    ]);
    expect(out).not.toContain('hunter22');
  });

  it('still passes digests, long identifiers and recorded ids in fixtures', () => {
    const repo = change(
      { 'src/a.ts': 'export const a = 1;\n' },
      {
        'src/a.ts': [
          'export const a = 1;',
          "const sha = '638410f3c34192ab0ec475cd2dd8bb48aea8b0123';",
          'const parseIssueFileWithComments2 = () => readLocalIssueFromDirectory3();',
          "const url = 'https://example.com/docs/reference/config';",
          '',
        ].join('\n'),
        'tests/fixtures/run.jsonl': '{"id":"call_FedyGrhSURK1rNKR2maItEP2"}\n',
      }
    );
    expect(run('safety.mjs', repo, ['src/', 'tests/'])).toEqual({ ok: true, out: 'safety: ok' });
  });
});

describe('size', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join('\n');

  it('fails a change over the line or file cap outside tests/', () => {
    const repo = change(
      { 'src/a.ts': '' },
      { 'src/a.ts': lines(20), 'src/b.ts': '1\n', 'src/c.ts': '1\n', 'docs/d.md': '1\n' }
    );
    const { ok, out } = run('size.mjs', repo, ['15', '3']);
    expect(ok).toBe(false);
    expect(findings(out)).toEqual([
      '23 added lines outside tests/, more than 15; split the task',
      '4 files changed outside tests/, more than 3: src/a.ts, docs/d.md, src/b.ts, src/c.ts',
    ]);
  });

  it('does not count tests', () => {
    const repo = change({ 'src/a.ts': '' }, { 'src/a.ts': lines(10), 'tests/a.test.ts': lines(500) });
    expect(run('size.mjs', repo, ['15', '3'])).toEqual({ ok: true, out: 'size: ok' });
  });

  it('does not count files that only delete lines toward the file cap', () => {
    const before = { 'src/a.ts': 'a\nb\n', 'src/b.ts': 'a\nb\n', 'src/c.ts': 'a\n', 'src/d.ts': '1\n' };
    const repo = change(before, { 'src/a.ts': 'a\n', 'src/b.ts': 'a\n', 'src/d.ts': '2\n' }, ['src/c.ts']);
    expect(run('size.mjs', repo, ['15', '1'])).toEqual({ ok: true, out: 'size: ok' });
  });

  it('reads its caps from the bounds file', () => {
    const repo = change({ 'src/a.ts': '' }, { 'src/a.ts': lines(301) });
    expect(findings(run('size.mjs', repo).out)).toEqual([
      '301 added lines outside tests/, more than 300; split the task',
    ]);
  });

  it('does not count files that only make the change-wide word swap toward the file cap', () => {
    const uses = (key: string) => `if (p.${key} === 'reply') send(p);\nconst { ${key} } = p;\n`;
    const before = { 'src/a.ts': uses('kind'), 'src/b.ts': uses('kind'), 'src/c.ts': uses('kind'), 'src/d.ts': '1\n' };
    const renamed = { 'src/a.ts': uses('type'), 'src/b.ts': uses('type'), 'src/c.ts': uses('type') };
    expect(run('size.mjs', change(before, { ...renamed, 'src/d.ts': '2\n' }), ['15', '1'])).toEqual({
      ok: true,
      out: 'size: ok',
    });
    const { ok, out } = run(
      'size.mjs',
      change(before, { ...renamed, 'src/c.ts': uses('variant'), 'src/d.ts': '2\n' }),
      ['15', '1']
    );
    expect(ok).toBe(false);
    expect(findings(out)).toEqual([
      '2 files changed outside tests/ besides 2 that only rename kind → type, more than 1: src/c.ts, src/d.ts',
    ]);
  });
});

describe('enum-copy', () => {
  const declared = {
    'src/store.ts': "export type RunStatus =\n  | 'queued'\n  | 'running'\n  | 'failed'\n  | 'skipped';\n",
    'src/schema.ts': "export const Closure = z.enum(['done', 'blocked', 'deferred']);\n",
  };

  it('fails an added list of every value of a declared union, or all but one', () => {
    const repo = change(declared, {
      'src/run.ts':
        "const all = ['queued', 'running', 'failed'];\nconst closures = new Set([\n  'done',\n  'blocked',\n  'deferred',\n]);\n",
      'examples/bothub/scripts/t.mjs': "const s = ['failed', 'skipped', 'running', 'queued'];\n",
    });
    expect(findings(run('enum-copy.mjs', repo).out)).toEqual([
      'examples/bothub/scripts/t.mjs:1: copies the values of RunStatus in src/store.ts; read them from there instead',
      'src/run.ts:1: copies the values of RunStatus in src/store.ts; read them from there instead',
      'src/run.ts:2: copies the values of Closure in src/schema.ts; read them from there instead',
    ]);
  });

  it('passes a subset, a list with other values, the declaration itself and tests', () => {
    const repo = change(declared, {
      'src/run.ts': "const failed = ['failed', 'skipped'];\nconst mixed = ['queued', 'running', 'failed', 'gone'];\n",
      'src/schema.ts': "export const Closure = z.enum(['done', 'blocked', 'deferred', 'no-op']);\n",
      'tests/run.test.ts': "const all = ['queued', 'running', 'failed', 'skipped'];\n",
    });
    expect(run('enum-copy.mjs', repo)).toEqual({ ok: true, out: 'enum-copy: ok' });
  });

  it('fails a named number the change shares between src/ and a hub script, but not 0, 1, 2 or a length', () => {
    const repo = change(
      { 'examples/bothub/scripts/criteria.mjs': 'const item = { calls: 5, tries: 1 };\nif (s.length > 3) go();\n' },
      {
        'src/checks.ts': 'if (judgment.calls !== 5 || tries === 1 || s.length > 3 || other: 5) stop();\n',
        'examples/bothub/scripts/criteria.mjs':
          'const item = { calls: 5, tries: 1, budget: 9 };\nif (s.length > 3) go();\n',
      }
    );
    expect(findings(run('enum-copy.mjs', repo).out)).toEqual([
      'examples/bothub/scripts/criteria.mjs:1: `calls = 5` is also in src/checks.ts; keep the number in one place',
      'src/checks.ts:1: `calls = 5` is also in examples/bothub/scripts/criteria.mjs; keep the number in one place',
    ]);
  });
});

describe('unused-exports', () => {
  const pull = (key: string) =>
    `export type NewPull = { ${key}: 'merge-request' };\nexport const open = (p: NewPull) => p;\n`;
  const use = (key: string) => `import { open } from './pull.ts';\nopen({ ${key}: 'merge-request' });\n`;

  it('leaves alone an export the change only renames in, and fails one it adds', () => {
    const before = { 'src/pull.ts': pull('kind'), 'src/use.ts': use('kind'), 'src/other.ts': use('kind') };
    expect(
      run(
        'unused-exports.mjs',
        change(before, { 'src/pull.ts': pull('type'), 'src/use.ts': use('type'), 'src/other.ts': use('type') })
      )
    ).toEqual({ ok: true, out: 'unused-exports: ok' });
    const { ok, out } = run(
      'unused-exports.mjs',
      change(before, {
        'src/pull.ts': `${pull('type')}export const close = 1;\n`,
        'src/use.ts': use('type'),
        'src/other.ts': use('type'),
      })
    );
    expect(ok).toBe(false);
    expect(findings(out)).toEqual([
      'src/pull.ts:3: close is exported but no other file uses it; drop the export or the code',
    ]);
  });

  it('fails a new file only tests import, and passes one code imports', () => {
    const lib = 'export const plan = (n: number) => n;\n';
    const test = "import { plan } from '../src/plan.ts';\nplan(1);\n";
    const { ok, out } = run('unused-exports.mjs', change({}, { 'src/plan.ts': lib, 'tests/plan.test.ts': test }));
    expect(ok).toBe(false);
    expect(findings(out)).toEqual([
      'src/plan.ts: a new file nothing outside tests imports; call it from the code that needs it',
    ]);
    const wired = { 'src/plan.ts': lib, 'src/run.ts': "import { plan } from './plan.ts';\nplan(1);\n" };
    expect(run('unused-exports.mjs', change({ 'src/run.ts': '' }, wired))).toEqual({
      ok: true,
      out: 'unused-exports: ok',
    });
  });

  it.each([
    [
      'an optional field nothing sets',
      "export type Spec = {\n  cwd: string;\n  decider?: string;\n};\nexport const spec: Spec = { cwd: '.' };\n",
      'src/spec.ts:3: decider is a new optional field nothing outside tests sets; set it where the value is made, or drop it',
    ],
    [
      'an event type nothing reads',
      "export type Event = { type: 'start' } | { type: 'decision'; p: number };\nexport const event: Event = { type: 'decision', p: 1 };\nexport const start = (e: Event) => e.type === 'start';\n",
      "src/spec.ts:1: 'decision' is a new event type nothing outside tests reads; handle it where events are read, or drop it",
    ],
  ])('fails %s', (_, code, finding) => {
    const user =
      "import { Spec, spec, Event, event, start } from './spec.ts';\nexport const use = [spec, event, start];\n";
    const { ok, out } = run(
      'unused-exports.mjs',
      change({ 'src/spec.ts': '', 'src/use.ts': user }, { 'src/spec.ts': code })
    );
    expect(ok).toBe(false);
    expect(findings(out)).toEqual([finding]);
  });

  it('passes a new optional field code sets and a new event type code reads', () => {
    const code = [
      "export type Event = { type: 'decision'; tool?: string };",
      "export const event: Event = { type: 'decision', tool: 'edit' };",
      "export const decided = (e: Event) => e.type === 'decision';",
      '',
    ].join('\n');
    const user = "import { Event, event, decided } from './spec.ts';\nexport const use = [event, decided];\n";
    const repo = change({ 'src/spec.ts': '', 'src/use.ts': user }, { 'src/spec.ts': code });
    expect(run('unused-exports.mjs', repo)).toEqual({ ok: true, out: 'unused-exports: ok' });
  });
});

describe('risky', () => {
  it('emits one item per added risky call in src/, with the code around it', () => {
    const repo = change(
      { 'src/a.ts': "import { spawn } from 'node:child_process';\nspawn('ls');\n" },
      {
        'src/a.ts': [
          "import { spawn } from 'node:child_process';",
          "spawn('ls');",
          'export const run = (cmd: string) => spawn(cmd, { shell: true });',
          '// fetch(url) is not called here',
          'export const token = process.env.TOKEN;',
          'export const load = (url: string) => fetch(url);',
          'export const clean = (dir: string) => rmSync(dir, { recursive: true });',
          'export const calc = (code: string) => eval(code);',
          '',
        ].join('\n'),
        'tests/a.test.ts': "spawn('rm');\n",
      }
    );
    const { ok, out } = run('risky.mjs', repo);
    expect(ok).toBe(true);
    const found = items(out);
    expect(found.map(i => [i.line, i.api])).toEqual([
      [3, 'a child process'],
      [5, 'an environment read'],
      [6, 'the network'],
      [7, 'a file removal or write'],
      [8, 'code evaluation'],
    ]);
    expect(found[0]).toMatchObject({
      file: 'src/a.ts',
      code: 'export const run = (cmd: string) => spawn(cmd, { shell: true });',
    });
    expect(found[0]!.context).toContain("spawn('ls');");
  });
});

const brief = [
  '## Task',
  'Replay labels added while serve was stopped, once each.',
  '',
  '## Criteria',
  "1. A label added while serve was stopped runs once after a restart. Test: it('replays a label added while stopped') in tests/labels.test.ts",
  "2. A label removed and added again by hand runs again. Test: it('replays a label re-added by hand') in `tests/labels.test.ts`",
  '3. Comments still replay. Test: it("still replays comments") in tests/labels.test.ts',
  '',
  '## Files',
  '- `src/labels.ts`: the delivery id of a label',
  '- `tests/labels.test.ts`',
  '',
  '## Out of scope',
  '- GitHub polling.',
  '',
].join('\n');

describe('triage-brief', () => {
  const check = (text: string) => {
    const dir = temp('brief');
    writeFileSync(join(dir, 'reply.md'), text);
    return run('triage-brief.mjs', { dir, base: '' }, [join(dir, 'reply.md')]);
  };

  it('passes a brief in the template', () => {
    expect(check(brief)).toEqual({ ok: true, out: 'triage-brief: ok' });
  });

  it('fails the free-form brief a triager wrote without the template', () => {
    const drifted = [
      '## Task',
      'Replay local labels after a restart.',
      '',
      '## Current behavior',
      '`serveHub` primes the delivery ledger.',
      '',
      '## Where',
      '- `src/issues-local.ts`',
      '',
      '## Out of scope',
      'GitHub polling.',
      '',
      '## Acceptance criteria',
      '1. With replay, startup emits labeled events. Proof: add watcher tests in `tests/issues.test.ts`.',
      '',
    ].join('\n');
    const { ok, out } = check(drifted);
    expect(ok).toBe(false);
    expect(findings(out)).toEqual([
      'the headings must be exactly "## Task", "## Criteria", "## Files", "## Out of scope", in that order',
      '"## Current behavior" is not a section of the template',
      '"## Where" is not a section of the template',
      '"## Acceptance criteria" is not a section of the template',
      'there are no criteria',
      'the files section names no file in backticks',
    ]);
  });

  it('fails too many criteria, a criterion without a test, a shared title and a non-test file', () => {
    const many = Array.from({ length: 6 }, (_, i) => `${i + 1}. Result ${i}. Test: it('t${i}') in tests/a.test.ts`);
    const text = brief.replace(
      /## Criteria\n[\s\S]*?\n\n/,
      `## Criteria\n${many.join('\n')}\n7. Works well.\n8. Again. Test: it('t0') in src/a.ts\n\n`
    );
    const { ok, out } = check(text);
    expect(ok).toBe(false);
    expect(findings(out)).toEqual([
      'a criterion does not end with "Test: it(\'<title>\') in tests/<file>.test.ts": 7. Works well.',
      'criterion 8 names src/a.ts, not a test file under tests/',
      '7 criteria; split the task to keep at most 5',
      'two criteria share the test title "t0"',
    ]);
  });

  it('fails a file outside the roots the change may touch', () => {
    const dir = temp('brief');
    const text = brief.replace(
      '- `tests/labels.test.ts`',
      '- `studio/src/App.tsx`: the view\n- `tests/labels.test.ts`'
    );
    writeFileSync(join(dir, 'reply.md'), text);
    const { ok, out } = run('triage-brief.mjs', { dir, base: '' }, ['--within', 'src/,tests/', join(dir, 'reply.md')]);
    expect(ok).toBe(false);
    expect(findings(out)).toEqual([
      'studio/src/App.tsx is outside what the change may touch (src/, tests/); leave it out of scope or ask',
    ]);
    expect(
      run('triage-brief.mjs', { dir, base: '' }, ['--within', 'src/,studio/src/,tests/', join(dir, 'reply.md')]).ok
    ).toBe(true);
  });

  it('allows the example hubs by default, so a schema change can migrate them', () => {
    const text = brief.replace('- `tests/labels.test.ts`', '- `examples/bothub/hub.yaml`\n- `tests/labels.test.ts`');
    expect(check(text)).toEqual({ ok: true, out: 'triage-brief: ok' });
    const outside = brief.replace('- `tests/labels.test.ts`', '- `bin/bothub.mjs`\n- `tests/labels.test.ts`');
    expect(findings(check(outside).out)).toEqual([
      'bin/bothub.mjs is outside what the change may touch (src/, tests/, studio/src/, studio/seed.ts, docs/, examples/, infra/local/sandbox/, infra/local/README.md); leave it out of scope or ask',
    ]);
  });

  it('points the triage skill at the bounds file instead of copying its paths', async () => {
    const { paths, maxFiles } = await import(join(scripts, 'bounds.mjs'));
    const skill = readFileSync(join(scripts, '../skills/triage.md'), 'utf8').replace(/\s+/g, ' ');
    expect(skill).toContain('may touch only the paths the safety check allows');
    expect(paths.filter((path: string) => skill.includes(`\`${path}\``))).toEqual(['src/', 'tests/']);
    expect(skill).toContain(`at most ${maxFiles} files outside \`tests/\``);
  });

  it('tells the triager only the fields the ask schema accepts', () => {
    const ask = Proposal.options.find(option => option.shape.kind.value === 'ask')!;
    const skill = readFileSync(join(scripts, '../skills/triage.md'), 'utf8').replace(/\s+/g, ' ');
    const fields = Object.keys(ask.shape).filter(key => key !== 'kind');
    expect(skill).toContain(`\`ask\` has only a ${fields.map(f => `\`${f}\``).join(', ')};`);
    expect(skill).not.toMatch(/its title is/i);
  });

  it('fails a brief naming a file the safety check would fail', () => {
    const text = brief.replace(
      '- `tests/labels.test.ts`',
      '- `examples/bothub/skills/review-transitions.md`\n- `src/CLAUDE.md`\n- `tests/labels.test.ts`'
    );
    expect(findings(check(text).out)).toEqual([
      'examples/bothub/skills/review-transitions.md: the safety check would fail it: a new report or tracking file; put the outcome where the project keeps its records',
      'src/CLAUDE.md: the safety check would fail it: writes harness memory (CLAUDE.md); propose a note instead',
    ]);
  });

  it("fails a path the issue's Done when names outside the bounds, unless the brief leaves it out of scope", () => {
    const hub = temp('brief-hub');
    write(hub, {
      'issues/7-x.md': '---\ntitle: x\n---\n## Done when\n\n- `infra/compose.yaml` runs it.\n- `src/a.ts` too.\n',
    });
    const dir = temp('brief');
    const env = { BOTHUB_HUB: hub, BOTHUB_ISSUE: '7' };
    const at = (text: string) => {
      writeFileSync(join(dir, 'reply.md'), text);
      return run('triage-brief.mjs', { dir, base: '' }, [join(dir, 'reply.md')], env);
    };
    expect(findings(at(brief).out)).toEqual([
      'the issue\'s Done when names infra/compose.yaml, outside what the change may touch (src/, tests/, studio/src/, studio/seed.ts, docs/, examples/, infra/local/sandbox/, infra/local/README.md); ask to allow it, or list it under "## Out of scope"',
    ]);
    expect(at(`${brief.trimEnd()}\n- Follow-up: \`infra/compose.yaml\` once it is allowed.\n`)).toEqual({
      ok: true,
      out: 'triage-brief: ok',
    });
  });

  it('with --width, flags only a brief naming more than twice as many files outside tests/ as Done when rows', () => {
    const hub = temp('brief-hub');
    write(hub, { 'issues/7-x.md': '---\ntitle: x\n---\n## Done when\n\n- One.\n- Two.\n- Three.\n' });
    const dir = temp('brief');
    const named = (n: number) => Array.from({ length: n }, (_, i) => `- \`src/f${i}.ts\``).join('\n');
    const width = (n: number) => {
      writeFileSync(join(dir, 'reply.md'), brief.replace(/## Files\n[\s\S]*?\n\n/, `## Files\n${named(n)}\n\n`));
      return run('triage-brief.mjs', { dir, base: '' }, ['--width', join(dir, 'reply.md')], {
        BOTHUB_HUB: hub,
        BOTHUB_ISSUE: '7',
      });
    };
    expect(width(6)).toEqual({ ok: true, out: 'triage-width: ok' });
    expect(findings(width(7).out)).toEqual([
      '7 files outside tests/ for 3 Done when rows; name only the files those rows need',
    ]);
  });

  it('with --width, flags a brief with more criteria than Done when rows', () => {
    const hub = temp('brief-hub');
    write(hub, { 'issues/7-x.md': '---\ntitle: x\n---\n## Done when\n\n- One.\n- Two.\n' });
    const dir = temp('brief');
    writeFileSync(join(dir, 'reply.md'), brief);
    const { out } = run('triage-brief.mjs', { dir, base: '' }, ['--width', join(dir, 'reply.md')], {
      BOTHUB_HUB: hub,
      BOTHUB_ISSUE: '7',
    });
    expect(findings(out)).toEqual(['3 criteria for 2 Done when rows; map the criteria one to one onto the rows']);
  });

  it('fails a brief naming more files outside tests/ than the size cap, and says to split it', () => {
    const named = (n: number) => Array.from({ length: n }, (_, i) => `- \`src/f${i}.ts\``).join('\n');
    const tests = Array.from({ length: 4 }, (_, i) => `- \`tests/t${i}.test.ts\``).join('\n');
    const withFiles = (n: number) => brief.replace(/## Files\n[\s\S]*?\n\n/, `## Files\n${named(n)}\n${tests}\n\n`);
    expect(check(withFiles(8))).toEqual({ ok: true, out: 'triage-brief: ok' });
    const { ok, out } = check(withFiles(9));
    expect(ok).toBe(false);
    expect(findings(out)).toEqual([
      "9 files outside tests/, more than the size check's cap of 8; split the task into tasks that each fit and ask which comes first",
    ]);
  });

  it('passes with a note when there is no reply to read', () => {
    expect(run('triage-brief.mjs', { dir: temp('brief'), base: '' })).toEqual({
      ok: true,
      out: 'triage-brief: no reply to check; it is read from BOTHUB_REPLY',
    });
  });
});

/** A hub with one ready local issue whose last bot comment is `brief`. */
const hubWith = (text: string) => {
  const hub = temp('hubdir');
  write(hub, {
    'issues/1-labels.md': [
      '---',
      'title: Labels',
      'state: open',
      'labels: [ready]',
      '---',
      '',
      'Labels are lost.',
      '',
      '## @morgan at 2026-10-13T09:00:00.000Z',
      '',
      '/bothub',
      '',
      '## @bothub[bot] at 2026-10-13T09:01:00.000Z',
      '',
      text,
    ].join('\n'),
    'issues/2-other.md': '---\ntitle: Other\nstate: open\nlabels: []\n---\n\nNo brief.\n',
  });
  return hub;
};

describe('test-guards: criterion tests', () => {
  const tests = (...titles: string[]) =>
    ["import { it } from 'vitest';", ...titles.map(t => `it('${t}', () => {});`), ''].join('\n');

  it('passes when the change adds every criterion test with its exact title, read from the issue', () => {
    const repo = change(
      { 'tests/labels.test.ts': tests('still replays comments') },
      {
        'tests/labels.test.ts': tests(
          'still replays comments',
          'replays a label added while stopped',
          'replays a label re-added by hand'
        ),
      }
    );
    expect(guards(repo, { BOTHUB_HUB: hubWith(brief) })).toMatchObject({ ok: true, out: 'test-guards: ok' });
  });

  it('fails a criterion whose test is missing or renamed', () => {
    const repo = change(
      { 'tests/labels.test.ts': tests('replays a label added while stopped') },
      { 'tests/labels.test.ts': tests('replays a label added while stopped', 'replays labels after a restart') }
    );
    const { ok, found } = guards(repo, { BOTHUB_HUB: hubWith(brief), BOTHUB_ISSUE: '1' });
    expect(ok).toBe(false);
    expect(found).toEqual([
      "criterion 1: no test titled 'replays a label added while stopped' added in tests/labels.test.ts; add it with that exact title",
      "criterion 2: no test titled 'replays a label re-added by hand' added in tests/labels.test.ts; add it with that exact title",
      "criterion 3: no test titled 'still replays comments' in tests/labels.test.ts; add it with that exact title",
      "tests/labels.test.ts:3: 'replays labels after a restart' is not a criterion of the brief; one test per criterion, so fold it into that criterion's test or drop it",
    ]);
  });

  it('fails a reply that closes the issue when the brief lists follow-ups', () => {
    const split = brief.replace('- GitHub polling.', '- Follow-up: GitHub polling.');
    const repo = change(
      {},
      {
        'tests/labels.test.ts': tests(
          'replays a label added while stopped',
          'replays a label re-added by hand',
          'still replays comments'
        ),
      }
    );
    const env = { BOTHUB_HUB: hubWith(split), BOTHUB_ISSUE: '1' };
    expect(guards(repo, { ...env, BOTHUB_REPLY: 'Part of #1' })).toMatchObject({ ok: true, out: 'test-guards: ok' });
    expect(guards(repo, { ...env, BOTHUB_REPLY: 'Closes #1' }).found).toEqual([
      'the reply says "Closes #1", but the brief lists follow-ups, so the issue stays open; say "Part of #<issue>"',
    ]);
  });

  it('says so when there is no brief to read', () => {
    const repo = change({ 'a.txt': '' });
    expect(guards(repo)).toMatchObject(guardsOk);
  });
});

const labels = {
  before: [
    'export const add = (issue: { labels: string[] }, label: string) => {',
    '  issue.labels.push(label);',
    '};',
    '',
    'export const remove = (issue: { labels: string[] }, label: string) => {',
    '  issue.labels = issue.labels.filter(l => l !== label);',
    '};',
    '',
  ].join('\n'),
  after: [
    'export const add = (issue: { labels: string[]; added: Record<string, number> }, label: string) => {',
    '  issue.labels.push(label);',
    '  issue.added[label] = (issue.added[label] ?? 0) + 1;',
    '};',
    '',
    'export const remove = (issue: { labels: string[] }, label: string) => {',
    '  issue.labels = issue.labels.filter(l => l !== label);',
    '};',
    '',
    'export const labelId = (issue: { added: Record<string, number> }, label: string) => `${label}-${issue.added[label]}`;',
    '',
  ].join('\n'),
};

describe('slicers for the narrow judges', () => {
  it('criteria: one item per criterion, with the task, its test and the change to src/', () => {
    const repo = change({ 'src/labels.ts': labels.before }, { 'src/labels.ts': labels.after });
    const env = { BOTHUB_BRIEF: join(hubWith(brief), 'issues/1-labels.md') };
    writeFileSync(env.BOTHUB_BRIEF, brief);
    const found = items(run('criteria.mjs', repo, [], env).out);
    expect(found.map(i => [i.path, i.test])).toEqual([
      ['criterion 1', "it('replays a label added while stopped') in tests/labels.test.ts"],
      ['criterion 2', "it('replays a label re-added by hand') in tests/labels.test.ts"],
      ['criterion 3', "it('still replays comments') in tests/labels.test.ts"],
    ]);
    expect(found[1]).toMatchObject({
      task: 'Replay labels added while serve was stopped, once each.',
      criterion: 'A label removed and added again by hand runs again.',
      'other criteria': ['A label added while serve was stopped runs once after a restart.', 'Comments still replay.'],
      'out of scope': ['GitHub polling.'],
    });
    expect(found[1]!.change).toContain('+export const labelId');
  });

  it('criteria: carries the code of each criterion test the worktree has', () => {
    const test = [
      "it('replays a label added while stopped', () => {",
      "  expect(add({ labels: [] }, 'a (b)')).toBe(')');",
      '});',
    ].join('\n');
    const file = [
      "import { expect, it } from 'vitest';",
      '',
      test,
      '',
      "it('replays a label re-added by hand', () => expect(1).toBe(1));",
    ].join('\n');
    const repo = change(
      { 'src/labels.ts': labels.before },
      { 'src/labels.ts': labels.after, 'tests/labels.test.ts': `${file}\n` }
    );
    const env = { BOTHUB_BRIEF: join(hubWith(brief), 'issues/1-labels.md') };
    writeFileSync(env.BOTHUB_BRIEF, brief);
    const found = items(run('criteria.mjs', repo, [], env).out);
    expect(found.map(i => i['test code'])).toEqual([
      test,
      "it('replays a label re-added by hand', () => expect(1).toBe(1));",
      undefined,
    ]);
  });

  it('criteria: the change holds only the changed files the test file names, else the whole change', () => {
    const criteriaFor = (test: string) => {
      const repo = change(
        {
          'src/labels.ts': labels.before,
          'src/util.ts': 'export const u = 1;\n',
          'src/other.ts': 'export const o = 1;\n',
        },
        {
          'src/labels.ts': `import { u } from './util.ts';\n${labels.after}`,
          'src/util.ts': 'export const u = 2;\n',
          'src/other.ts': 'export const o = 2;\n',
          'tests/labels.test.ts': test,
        }
      );
      const env = { BOTHUB_BRIEF: join(hubWith(brief), 'issues/1-labels.md') };
      writeFileSync(env.BOTHUB_BRIEF, brief);
      return items(run('criteria.mjs', repo, [], env).out)[0]!.change as string;
    };
    const narrow = criteriaFor("import { labelId } from '../src/labels.ts';\n");
    expect(narrow).toContain('+export const labelId');
    expect(narrow).not.toContain('src/util.ts');
    expect(narrow).not.toContain('src/other.ts');
    expect(criteriaFor("run('other.ts');\n")).toMatch(/^diff --git a\/src\/other\.ts[^]*\+export const o = 2;$/);
    expect(criteriaFor("import { gone } from '../src/gone.ts';\n")).toContain('+export const o = 2;');
  });

  it('reduce: one item with the criteria and the added lines under file and line', () => {
    const repo = change({ 'src/labels.ts': labels.before }, { 'src/labels.ts': labels.after });
    const env = { BOTHUB_BRIEF: join(hubWith(brief), 'issues/1-labels.md') };
    writeFileSync(env.BOTHUB_BRIEF, brief);
    const [item] = items(run('reduce.mjs', repo, [], env).out);
    expect(item!['done when']).toHaveLength(3);
    expect(item!.added).toContain('src/labels.ts:');
    expect(item!.added).toContain(': export const labelId');
  });

  const reduced = (after: Record<string, string>) => {
    const repo = change({ 'src/ast.ts': 'export const parseSource = (code: string) => code;\n' }, after);
    const env = { BOTHUB_BRIEF: join(hubWith(brief), 'issues/1-labels.md') };
    writeFileSync(env.BOTHUB_BRIEF, brief);
    return items(run('reduce.mjs', repo, [], env).out)[0]!;
  };

  it('reduce: shows each new function with the existing helpers that share a word with it', () => {
    const item = reduced({ 'src/tests.ts': 'const parseTests = (code: string) => code.split("it(");\n' });
    expect(item.helpers).toEqual([
      {
        function: 'src/tests.ts:1: const parseTests = (code: string) => code.split("it(");',
        existing: ['src/ast.ts:1: export const parseSource = (code: string) => code;'],
      },
    ]);
  });

  it('reduce: lists no helpers for a new function nothing in the repo shares a word with', () => {
    const item = reduced({ 'src/clock.ts': 'export function tickOnce() {\n  return 1;\n}\n' });
    expect(item.added).toContain('src/clock.ts:1: export function tickOnce() {');
    expect(item).not.toHaveProperty('helpers');
  });

  it('scope: only the changed files the brief does not name', () => {
    const repo = change(
      { 'src/labels.ts': labels.before, 'src/serve.ts': 'export const s = 1;\n' },
      { 'src/labels.ts': labels.after, 'tests/labels.test.ts': 'x\n', 'src/serve.ts': 'export const s = 2;\n' }
    );
    const found = items(run('scope.mjs', repo, [], { BOTHUB_HUB: hubWith(brief) }).out);
    expect(found).toEqual([
      {
        file: 'src/serve.ts',
        task: 'Replay labels added while serve was stopped, once each.',
        'out of scope': ['GitHub polling.'],
        change: 'export const s = 2;',
      },
    ]);
  });

  it('exports: one item per file with its new exports and the existing exports that share a word with them', () => {
    const repo = change(
      {
        'src/issues.ts': 'export const parseIssue = (s: string) => s;\nexport type Issue = { n: number };\n',
        'src/other.ts': 'export const unrelated = 1;\n',
      },
      {
        'src/issues.ts': 'export const parseIssue = (s: string) => s.trim();\nexport type Issue = { n: number };\n',
        'src/files.ts': 'export const parseIssueFile = (s: string) => s;\nexport const zebra = 2;\n',
      }
    );
    const found = items(run('exports.mjs', repo).out);
    expect(found).toEqual([
      {
        file: 'src/files.ts',
        exports: ['1: export const parseIssueFile = (s: string) => s;'],
        neighbours: [
          'src/issues.ts:1: export const parseIssue = (s: string) => s;',
          'src/issues.ts:2: export type Issue = { n: number };',
        ],
      },
    ]);
  });

  it('hunks: code hunks under the roots, leaving out comment-only ones, and new files whole', () => {
    const code = Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i};`);
    const edited = [...code];
    edited[2] = '// a note on v2';
    edited[3] = 'export const v3 = 33;';
    const commented = [...code];
    commented.splice(30, 0, '// only a comment');
    const repo = change(
      { 'src/a.ts': code.join('\n'), 'src/b.ts': code.join('\n'), 'docs/a.md': '# A\n' },
      {
        'src/a.ts': edited.join('\n'),
        'src/b.ts': commented.join('\n'),
        'src/new.ts': 'export const n = 1;\n',
        'docs/a.md': '# A\n\n* a bullet\n',
      }
    );
    const found = items(run('hunks.mjs', repo, ['src/']).out);
    expect(found.map(i => [i.file, i.line])).toEqual([
      ['src/a.ts', 1],
      ['src/new.ts', 1],
    ]);
    expect(found[0]!.hunk).toContain('+export const v3 = 33;');
    const docs = items(run('hunks.mjs', repo, ['docs/']).out);
    expect(docs.map(i => i.file)).toEqual(['docs/a.md']);
  });

  it("hunks: each hunk carries the brief's out-of-scope list", () => {
    const repo = change({ 'src/labels.ts': labels.before }, { 'src/labels.ts': labels.after });
    const found = items(run('hunks.mjs', repo, ['src/'], { BOTHUB_HUB: hubWith(brief) }).out);
    expect(found.length).toBeGreaterThan(0);
    expect(found.map(i => i['out of scope'])).toEqual(found.map(() => ['GitHub polling.']));
  });

  it('hunks: leaves out hunks that only make the change-wide rename, keeps the rest of a file', () => {
    const uses = (key: string) => `if (p.${key} === 'reply') send(p);\nconst { ${key} } = p;\n`;
    const filler = Array.from({ length: 20 }, (_, i) => `export const v${i} = ${i};`).join('\n');
    const repo = change(
      { 'src/a.ts': uses('kind'), 'src/b.ts': uses('kind'), 'src/c.ts': `${uses('kind')}${filler}\nconst x = 1;\n` },
      { 'src/a.ts': uses('type'), 'src/b.ts': uses('type'), 'src/c.ts': `${uses('type')}${filler}\nconst x = 2;\n` }
    );
    const found = items(run('hunks.mjs', repo, ['src/']).out);
    expect(found.map(i => [i.file, i.line])).toEqual([['src/c.ts', 15]]);
    expect(found[0]!.hunk).toContain('+const x = 2;');
  });
});

describe('removed', () => {
  const found = (before: string, after: string, extra: Record<string, string> = {}) =>
    items(
      run('removed.mjs', change({ 'src/a.ts': before, ...extra }, { 'src/a.ts': after }), [], {
        BOTHUB_HUB: temp('empty'),
      }).out
    ).map(i => [i.kind, i.removed]);

  it('names a removed argument, with the hunk that replaces it', () => {
    const repo = change({ 'src/a.ts': 'send(task, next.summary);\n' }, { 'src/a.ts': 'send(task);\n' });
    const [item] = items(run('removed.mjs', repo, [], { BOTHUB_HUB: temp('empty') }).out);
    expect(item).toMatchObject({ kind: 'argument', file: 'src/a.ts', line: 1, removed: ['send(task, next.summary);'] });
    expect(item!.replacing).toContain('+send(task);');
  });

  it('names a removed fallback, a removed ternary and a removed export', () => {
    expect(found('const a = x ?? y;\n', 'const a = x;\n')).toEqual([['branch', ['const a = x ?? y;']]]);
    expect(found('const a = own.length ? own : roots;\n', 'const a = roots;\n')).toEqual([
      ['branch', ['const a = own.length ? own : roots;']],
    ]);
    expect(found('export const gone = 1;\nexport const kept = 2;\n', 'export const kept = 2;\n')).toEqual([
      ['export', ['export const gone = 1;']],
    ]);
  });

  it('leaves out a line the change adds back elsewhere and an edit that keeps the branch', () => {
    expect(found('const a = x ?? y;\n', 'const b = 1;\n', { 'src/b.ts': '' })).toEqual([
      ['branch', ['const a = x ?? y;']],
    ]);
    const moved = change(
      { 'src/a.ts': 'export const f = 1;\n' },
      { 'src/a.ts': '', 'src/b.ts': 'export const f = 1;\n' }
    );
    expect(run('removed.mjs', moved, [], { BOTHUB_HUB: temp('empty') }).out).toBe('');
    expect(found('const a = x ?? y;\n', 'const a = x ?? z;\n')).toEqual([]);
  });

  it('ignores tests and comments', () => {
    const repo = change(
      { 'src/a.ts': '// a ?? b\n', 'tests/a.test.ts': 'send(a, b.c);\n' },
      { 'src/a.ts': '', 'tests/a.test.ts': 'send(a);\n' }
    );
    expect(run('removed.mjs', repo, [], { BOTHUB_HUB: temp('empty') }).out).toBe('');
  });
});

describe('principles', () => {
  const examples = resolve(scripts, '../..');
  const skill = (hub: string) => readFileSync(join(examples, hub, 'skills/principles.md'), 'utf8');

  it('the three hubs carry the same principles skill', () => {
    expect(skill('acme-app')).toBe(skill('bothub'));
    expect(skill('clarinet')).toBe(skill('bothub'));
  });

  it('each principle note body appears in the skill', () => {
    const dir = join(examples, 'bothub/notes/style');
    const notes = readdirSync(dir)
      .filter(name => readFileSync(join(dir, name), 'utf8').includes('check: principle-named'))
      .map(name => readFileSync(join(dir, name), 'utf8').split(/^---$/m)[2]!.trim());
    expect(notes).toHaveLength(8);
    expect(notes.filter(body => !skill('bothub').includes(body))).toEqual([]);
  });

  it('principles.mjs pairs each named principle with the hunk at its line', () => {
    const repo = change({ 'src/a.ts': 'export const a = 1;\n' }, { 'src/a.ts': 'export const a = clamp(1);\n' });
    const reply = 'Smallest change (src/a.ts:1)\nBound every input (src/b.ts:4)\nno principle src/a.ts:1';
    const found = items(run('principles.mjs', repo, [], { BOTHUB_REPLY: reply }).out);
    expect(found.map(i => i.path)).toEqual(['src/a.ts:1 Smallest change', 'src/b.ts:4 Bound every input']);
    expect(found[0]!.hunk).toContain('+export const a = clamp(1);');
    expect(found[0]!.principle).toContain('Tempted to edit a shared function');
    expect(found[1]!.hunk).toBe('(no changed hunk at that line)');
  });
});
