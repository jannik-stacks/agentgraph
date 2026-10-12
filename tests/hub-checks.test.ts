import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runScript, unsandboxed } from '../src/runner.ts';
import { git, temp } from './git.ts';

const hub = resolve(import.meta.dirname, '../examples/acme-app');
const scripts = join(hub, 'scripts');
const bin = resolve(import.meta.dirname, '../node_modules/.bin');

const write = (root: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
};

/** A repository with `before` committed as the base, then `after` written on top without committing. */
const change = (before: Record<string, string>, after: Record<string, string> = {}) => {
  const dir = temp('change');
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, { '.gitignore': 'node_modules/\n', ...before });
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, after);
  return { dir, base };
};

const check = (script: string, { dir, base }: { dir: string; base?: string }, ...args: string[]) => {
  const result = spawnSync(process.execPath, [join(scripts, script), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, ...(base && { BOTHUB_BASE: base }) },
  });
  return { ok: result.status === 0, out: `${result.stdout}${result.stderr}`.trim() };
};

describe('safety check', () => {
  it('passes a change inside the allowed paths', () => {
    const repo = change({ 'kit/src/a.ts': 'export const a = 1;\n' }, { 'kit/src/b.ts': 'export const b = 2;\n' });
    expect(check('safety.mjs', repo, 'kit/', 'docs/')).toEqual({ ok: true, out: 'safety: ok' });
  });

  it('fails edits outside the allowed paths, env files, keys, CI config and deletions out of scope', () => {
    const repo = change(
      { 'README.md': 'hi\n', 'kit/a.ts': 'x\n' },
      {
        'README.md': 'changed\n',
        '.env': 'X=1\n',
        'kit/.env.local': 'X=1\n',
        'kit/.env.example': 'X=\n',
        'kit/certs/server.pem': 'pem\n',
        '.github/workflows/ci.yml': 'on: push\n',
      }
    );
    rmSync(join(repo.dir, 'kit/a.ts'));
    const { ok, out } = check('safety.mjs', repo, 'kit/');
    expect(ok).toBe(false);
    expect(out).toContain('README.md: outside the allowed paths (kit/)');
    expect(out).toContain('.env: an environment file must not change');
    expect(out).toContain('kit/.env.local: an environment file must not change');
    expect(out).not.toContain('kit/.env.example');
    expect(out).toContain('kit/certs/server.pem: key material must not change');
    expect(out).toContain('.github/workflows/ci.yml: CI configuration must not change');
    expect(out).not.toContain('kit/a.ts');
  });

  it('fails added secrets by line, without echoing them, and ignores ones already in the base', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const repo = change(
      { 'kit/old.ts': `const old = '${token}';\n` },
      {
        'kit/old.ts': `const old = '${token}';\nconst key = 'sk-${'b'.repeat(24)}';\n`,
        'kit/new.ts': `// nothing\n-----BEGIN OPENSSH PRIVATE KEY-----\n`,
        'kit/conf.ts': `const env = 'BOTHUB_LLM_API_KEY_IMPLEMENTOR=${'c'.repeat(20)}';\n`,
      }
    );
    const { ok, out } = check('safety.mjs', repo, 'kit/');
    expect(ok).toBe(false);
    expect(out.split('\n').slice(0, -1).sort()).toEqual([
      'kit/conf.ts:1: adds a key assignment',
      'kit/new.ts:2: adds a private key',
      'kit/old.ts:2: adds an API key',
    ]);
    expect(out).not.toContain('bbbb');
  });

  it('fails a new file over 512 KB but lets an existing large file change', () => {
    const big = 'x'.repeat(600 * 1024);
    const repo = change({ 'docs/api.json': big }, { 'docs/api.json': `${big}y`, 'docs/blob.json': big });
    const { ok, out } = check('safety.mjs', repo, 'docs/');
    expect(ok).toBe(false);
    expect(out.split('\n').slice(0, -1)).toEqual(['docs/blob.json: a new file larger than 512 KB']);
  });

  it('ignores gitignored files and fails without a base or allowed paths', () => {
    const repo = change({ 'kit/a.ts': 'x\n' }, { 'node_modules/.env': 'X=1\n' });
    expect(check('safety.mjs', repo, 'kit/').ok).toBe(true);
    expect(check('safety.mjs', { dir: repo.dir }, 'kit/')).toMatchObject({
      ok: false,
      out: expect.stringContaining('BOTHUB_BASE is not set'),
    });
    expect(check('safety.mjs', { dir: repo.dir, base: 'f'.repeat(40) }, 'kit/').ok).toBe(false);
    expect(check('safety.mjs', repo).out).toContain('usage: safety.mjs');
  });
});

describe('style check', () => {
  it('passes plain prose and plain comments', () => {
    const repo = change(
      { 'docs/a.mdx': '# Title\n' },
      {
        'docs/a.mdx': '# Title\n\nThe kit sends a call and waits for the result.\n',
        'kit/a.ts': '/** Sends a call. */\nexport const send = () => 1; // returns one\n',
      }
    );
    expect(check('style.mjs', repo)).toEqual({ ok: true, out: 'style: ok' });
  });

  it('flags the written rules on added lines only', () => {
    const repo = change(
      { 'docs/old.mdx': '# Old · page\n', 'kit/old.ts': '// 2026-01-01 ruling\nexport const x = 1;\n' },
      {
        'docs/old.mdx': '# Old · page\n\nA centerpiece of the kit.\n',
        'docs/new.mdx': [
          '# Sending a call: golden path',
          '## Retries — the honest version',
          '## C-001 — numbered items keep their dash',
          'A ⊃ B, and the value is inert.',
          '```ts',
          'const a = b · c;',
          '```',
        ].join('\n'),
        'kit/old.ts': '// 2026-01-01 ruling\nexport const x = 1;\n// renamed from y per decision 0008\n',
        'kit/new.ts': '/**\n * Added for Morgan on 2026-09-22.\n */\nexport const s = "a · b";\n',
      }
    );
    const { ok, out } = check('style.mjs', repo);
    expect(ok).toBe(false);
    expect(out.split('\n').slice(0, -1)).toEqual(
      expect.arrayContaining([
        'docs/old.mdx:3: a marketing word',
        'docs/new.mdx:1: a heading with a colon prefix or suffix',
        'docs/new.mdx:2: a marketing word',
        'docs/new.mdx:2: a heading with an em-dash tagline',
        'docs/new.mdx:4: a middle dot or math symbol; write the words instead',
        'docs/new.mdx:4: the word "inert"',
        'kit/old.ts:3: a ruling or decision reference in a comment',
        'kit/old.ts:3: history in a comment',
        'kit/new.ts:2: a date in a comment',
        'kit/new.ts:2: a name in a comment',
      ])
    );
    expect(out).not.toMatch(/docs\/old\.mdx:1|kit\/old\.ts:1|docs\/new\.mdx:3|docs\/new\.mdx:6|kit\/new\.ts:4/);
    expect(out).toContain('style: 10 findings');
  });
});

describe('lint check', () => {
  it('passes clean changed files and leaves the formatting of existing files alone', () => {
    const repo = change(
      { 'kit/old.ts': 'export const   old = 1\n' },
      { 'kit/old.ts': 'export const   old = 2\n', 'kit/new.ts': 'export const add = (a: number) => a + 1;\n' }
    );
    expect(check('lint.mjs', repo)).toEqual({ ok: true, out: 'lint: ok' });
  });

  it('fails lint errors in changed files and unformatted new files', () => {
    const repo = change(
      { 'kit/old.ts': 'export const old = 1;\n' },
      { 'kit/old.ts': 'var old = 1;\nexport { old };\n', 'kit/new.ts': 'export const   s = "double"\n' }
    );
    const { ok, out } = check('lint.mjs', repo);
    expect(ok).toBe(false);
    expect(out).toContain('oxlint found errors');
    expect(out).toContain('no-var');
    expect(out).toContain('new files are not formatted');
    expect(out).toContain('kit/new.ts');
  });

  it('tells how to format a new file with the hub settings, and the command it gives fixes it', () => {
    const repo = change({ 'kit/a.ts': 'export const a = 1;\n' }, { 'kit/new.ts': 'export const   s = "double"\n' });
    const first = check('lint.mjs', repo);
    expect(first.ok).toBe(false);
    const command = first.out.split('\n').find(line => line.startsWith("printf '%s'"));
    expect(command).toContain('oxfmt --config /tmp/oxfmtrc.json kit/new.ts');
    const fixed = spawnSync('sh', ['-c', command!.replaceAll('/tmp/oxfmtrc.json', join(repo.dir, '.oxfmtrc.json'))], {
      cwd: repo.dir,
      env: { PATH: `${bin}:${process.env.PATH}` },
    });
    expect(fixed.status).toBe(0);
    rmSync(join(repo.dir, '.oxfmtrc.json'));
    expect(check('lint.mjs', repo)).toEqual({ ok: true, out: 'lint: ok' });
  });

  it('fails when the linters are missing from the sandbox instead of passing', () => {
    const repo = change({ 'kit/a.ts': 'export const a = 1;\n' }, { 'kit/a.ts': 'export const a = 2;\n' });
    const result = spawnSync(process.execPath, [join(scripts, 'lint.mjs')], {
      cwd: repo.dir,
      encoding: 'utf8',
      env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, BOTHUB_BASE: repo.base },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('oxlint is not installed in this sandbox');
  });
});

describe('kit check', () => {
  it('installs locked dependencies once, reinstalls when the lockfile changes, and fails a broken install', async () => {
    const repo = change({
      'kit/package.json': '{ "name": "k", "version": "1.0.0", "private": true }\n',
      'kit/package-lock.json':
        '{ "name": "k", "version": "1.0.0", "lockfileVersion": 3, "requires": true, "packages": { "": { "name": "k", "version": "1.0.0" } } }\n',
    });
    const kit = (cmd: string) => runScript(`sh "$BOTHUB_HUB/scripts/kit.sh" ${cmd}`, repo.dir, 2, {}, unsandboxed, hub);
    const first = await kit('ls node_modules/.bothub-lock');
    expect(first.ok).toBe(true);
    expect(first.output).toMatch(/up to date[\s\S]*\nnode_modules\/\.bothub-lock$/);
    expect(await kit('sh -c "echo second >> node_modules/marker; cat node_modules/marker"')).toEqual({
      ok: true,
      output: 'second',
    });
    writeFileSync(join(repo.dir, 'kit/package-lock.json'), '{ "broken": ');
    expect((await kit('true')).ok).toBe(false);
  });
});
