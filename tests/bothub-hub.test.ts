import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { git, temp } from './git.ts';

const scripts = resolve(import.meta.dirname, '../examples/bothub/scripts');
const modules = resolve(import.meta.dirname, '../node_modules');

const write = (root: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
};

/** A repository with `before` committed as the base, then `after` written on top without committing. */
const change = (before: Record<string, string>, after: Record<string, string> = {}, remove: string[] = []) => {
  const dir = temp('hub');
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, { '.gitignore': 'node_modules\n', ...before });
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, after);
  for (const path of remove) rmSync(join(dir, path));
  return { dir, base };
};

/** Links bothub's own dependencies into a repository, the way the hub links them into a worktree. */
const withModules = <T extends { dir: string }>(repo: T) => {
  symlinkSync(modules, join(repo.dir, 'node_modules'));
  return repo;
};

const run = (
  script: string,
  { dir, base }: { dir: string; base: string },
  args: string[] = [],
  env: Record<string, string> = {}
) => {
  const result = spawnSync(process.execPath, [join(scripts, script), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: `${modules}/.bin:${process.env.PATH}`, BOTHUB_BASE: base, ...env },
  });
  return { ok: result.status === 0, out: `${result.stdout}${result.stderr}`.trim() };
};

const findings = (out: string) => out.split('\n').slice(0, -1);
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

describe('tests-bite', () => {
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
    const { ok, out } = run('tests-bite.mjs', repo);
    expect(ok).toBe(false);
    expect(findings(out)).toEqual([
      "tests/add.test.ts:5: 'adds a negative and a positive' passes on the base code, so it would not catch the change being reverted",
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
    expect(run('tests-bite.mjs', repo)).toEqual({ ok: true, out: 'tests-bite: ok' });
  });

  it('counts a new test file that cannot load on the base code as failing there', () => {
    const repo = withModules(
      change(
        { 'src/add.ts': adder },
        {
          'src/sub.ts': 'export const sub = (a: number, b: number) => a - b;\n',
          'tests/sub.test.ts':
            "import { expect, it } from 'vitest';\nimport { sub } from '../src/sub.ts';\nit('subtracts', () => expect(sub(3, 1)).toBe(2));\n",
        }
      )
    );
    expect(run('tests-bite.mjs', repo)).toEqual({ ok: true, out: 'tests-bite: ok' });
  });

  it('has nothing to bite when only tests change', () => {
    const repo = change({ 'tests/a.test.ts': '' }, { 'tests/a.test.ts': "it('x', () => {});\n" });
    expect(run('tests-bite.mjs', repo)).toEqual({
      ok: true,
      out: 'tests-bite: the change is only tests; nothing to bite',
    });
  });
});

describe('test-integrity', () => {
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
    const { ok, out } = run('test-integrity.mjs', repo);
    expect(ok).toBe(false);
    expect(findings(out).sort()).toEqual([
      'tests/a.test.ts: 1 fewer tests than the base (2 to 1)',
      'tests/a.test.ts: 2 fewer expect( calls than the base (3 to 1)',
      'tests/b.test.ts:5: an added .skip, .only or .todo',
      'tests/b.test.ts:6: an added .skip, .only or .todo',
      'tests/c.test.ts:5: a test timeout of 30000 ms, above the 5000 ms default',
      'tests/gone.test.ts: deletes a test file with 2 tests',
      'tests/setup/global.ts: edits the global test setup',
    ]);
  });

  it('passes added tests, short timeouts, process timeouts and skips on a real condition', () => {
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
      }
    );
    expect(run('test-integrity.mjs', repo)).toEqual({ ok: true, out: 'test-integrity: ok' });
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
    expect(run('tests-bite.mjs', changed())).toEqual({ ok: true, out: 'tests-bite: ok' });
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

describe('criteria-tests', () => {
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
    const env = { BOTHUB_HUB: hubWith(brief) };
    expect(run('criteria-tests.mjs', repo, [], env)).toEqual({ ok: true, out: 'criteria-tests: ok' });
  });

  it('fails a criterion whose test is missing or renamed', () => {
    const repo = change(
      { 'tests/labels.test.ts': tests('replays a label added while stopped') },
      { 'tests/labels.test.ts': tests('replays a label added while stopped', 'replays labels after a restart') }
    );
    const { ok, out } = run('criteria-tests.mjs', repo, [], { BOTHUB_HUB: hubWith(brief), BOTHUB_ISSUE: '1' });
    expect(ok).toBe(false);
    expect(findings(out)).toEqual([
      "criterion 1: no test titled 'replays a label added while stopped' added in tests/labels.test.ts; add it with that exact title",
      "criterion 2: no test titled 'replays a label re-added by hand' added in tests/labels.test.ts; add it with that exact title",
      "criterion 3: no test titled 'still replays comments' in tests/labels.test.ts; add it with that exact title",
    ]);
  });

  it('says so when there is no brief to read', () => {
    const repo = change({ 'a.txt': '' });
    expect(run('criteria-tests.mjs', repo, [], { BOTHUB_HUB: temp('empty') })).toEqual({
      ok: true,
      out: 'criteria-tests: no triage brief found for this run',
    });
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
    });
    expect(found[1]!.change).toContain('+export const labelId');
  });

  it('design: the task, then every changed function in full, so the remove path is in view', () => {
    const repo = change({ 'src/labels.ts': labels.before }, { 'src/labels.ts': labels.after });
    const { ok, out } = run('design.mjs', repo, [], { BOTHUB_HUB: hubWith(brief) });
    expect(ok).toBe(true);
    expect(out.startsWith('Task: Replay labels added while serve was stopped, once each.')).toBe(true);
    expect(out).toContain('2. A label removed and added again by hand runs again.');
    expect(out).toContain(' export const remove = ');
    expect(out).toContain('+export const labelId');
    const untouched = change({ 'src/labels.ts': labels.before }, { 'tests/a.test.ts': 'x\n' });
    expect(run('design.mjs', untouched, [], { BOTHUB_HUB: hubWith(brief) }).out).toBe('');
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

  it('exports: each new export with existing exports that share a word with its name', () => {
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
        line: 1,
        export: 'export const parseIssueFile = (s: string) => s;',
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
      { 'src/a.ts': code.join('\n'), 'src/b.ts': code.join('\n'), 'studio/content/docs/a.mdx': '# A\n' },
      {
        'src/a.ts': edited.join('\n'),
        'src/b.ts': commented.join('\n'),
        'src/new.ts': 'export const n = 1;\n',
        'studio/content/docs/a.mdx': '# A\n\n* a bullet\n',
      }
    );
    const found = items(run('hunks.mjs', repo, ['src/']).out);
    expect(found.map(i => [i.file, i.line])).toEqual([
      ['src/a.ts', 1],
      ['src/new.ts', 1],
    ]);
    expect(found[0]!.hunk).toContain('+export const v3 = 33;');
    const docs = items(run('hunks.mjs', repo, ['studio/content/docs/']).out);
    expect(docs.map(i => i.file)).toEqual(['studio/content/docs/a.mdx']);
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
