import { spawnSync } from 'node:child_process';
import { rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { context } from '../src/context.ts';
import { change, runScript, tmp } from './kit.ts';

const scripts = resolve(import.meta.dirname, '../examples/agentgraph/scripts');
const bin = resolve(import.meta.dirname, '../node_modules/.bin');

const check = (script: string, repo: { dir: string; base?: string }, ...args: string[]) =>
  runScript(resolve(scripts, script), repo, args, { PATH: `${bin}:${process.env.PATH}` });

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
        'kit/conf.ts': `const env = 'AGENTGRAPH_LLM_API_KEY_IMPLEMENTOR=${'c'.repeat(20)}';\n`,
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

  it('ignores gitignored files and fails without a base', () => {
    const repo = change({ 'kit/a.ts': 'x\n' }, { 'node_modules/.env': 'X=1\n' });
    expect(check('safety.mjs', repo, 'kit/').ok).toBe(true);
    expect(check('safety.mjs', { dir: repo.dir }, 'kit/')).toMatchObject({
      ok: false,
      out: expect.stringContaining('AGENTGRAPH_BASE is not set'),
    });
    expect(check('safety.mjs', { dir: repo.dir, base: 'f'.repeat(40) }, 'kit/').ok).toBe(false);
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

  it('fails when the linters are missing from the sandbox instead of passing', () => {
    const repo = change({ 'kit/a.ts': 'export const a = 1;\n' }, { 'kit/a.ts': 'export const a = 2;\n' });
    const onlyNode = tmp('only-node');
    symlinkSync(process.execPath, join(onlyNode, 'node'));
    const result = spawnSync(process.execPath, [join(scripts, 'lint.mjs')], {
      cwd: repo.dir,
      encoding: 'utf8',
      env: { PATH: `${onlyNode}:/usr/bin:/bin`, AGENTGRAPH_BASE: repo.base },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('oxlint is not installed in this sandbox');
  });
});

describe('agentgraph hub checks', () => {
  const at = (script: string) => join(scripts, script);

  it('flags dated or historical comments and symbol-laden docs lines a change adds', () => {
    const repo = change(
      { 'src/a.ts': 'export const a = 1;\n', 'docs/a.md': '# A\n' },
      {
        'src/a.ts': 'export const a = 1;\n// renamed from b on 2026-10-12\nexport const b = 2;\n',
        'docs/a.md': '# A\n\n## Sending — the golden path\n\nFast · simple.\n',
      }
    );
    const { ok, out } = check(at('rules.mjs'), repo);
    expect(ok).toBe(false);
    expect(out).toContain('src/a.ts:2: a date');
    expect(out).toContain('src/a.ts:2: history in a comment');
    expect(out).toContain('docs/a.md:3: a heading with an em-dash suffix');
    expect(out).toContain('docs/a.md:5: a middle dot separator');

    const clean = change({ 'src/a.ts': 'export const a = 1;\n' }, { 'src/a.ts': '// Plain.\nexport const a = 2;\n' });
    expect(check(at('rules.mjs'), clean)).toEqual({ ok: true, out: 'rules: ok' });
  });

  it('flags unicode diagram arrows, two-dot review diffs, update-ref without an old sha and a CLAUDE.md', () => {
    const repo = change(
      { 'src/a.ts': 'export const a = 1;\n', 'docs/a.md': '# A\n' },
      {
        'src/a.ts':
          "export const a = 1;\nawait inForge(i, ['update-ref', `refs/heads/${i.base}`, theirs]);\nawait inForge(i, ['update-ref', ref, head, current]);\n",
        'docs/a.md': '# A\n\n```\n      ▲\n      v\n```\n\nKeep `../x` and `a...b`.\n',
        'examples/agentgraph/skills/review.md':
          'Review the whole branch: `git diff bothub-main..HEAD -- agentgraph`.\n',
        'CLAUDE.md': '@AGENTS.md\n',
      }
    );
    const { ok, out } = check(at('rules.mjs'), repo);
    expect(ok).toBe(false);
    expect(out.split('\n').slice(0, -1).toSorted()).toEqual([
      'CLAUDE.md:1: a CLAUDE.md file; agent instructions live in AGENTS.md only',
      'docs/a.md:4: a unicode arrow in a fenced block; diagram arrow heads are ASCII > < v ^',
      'examples/agentgraph/skills/review.md:1: a two-dot diff range; review a branch with base...HEAD, or diff a recorded sha',
      'src/a.ts:2: update-ref without the expected old sha; pass it so a concurrent move fails',
    ]);
  });

  it('lints and format-checks the code files a change touches', () => {
    const repo = change(
      { '.oxlintrc.json': '{ "rules": { "no-debugger": "error" } }\n', 'src/a.ts': 'export const a = 1;\n' },
      { 'src/a.ts': 'export const a = 1;\ndebugger;\n' }
    );
    const lint = check(at('lint.mjs'), repo);
    expect(lint.ok).toBe(false);
    expect(lint.out).toContain('src/a.ts:2: eslint(no-debugger)');
    const config = { '.oxfmtrc.json': '{ "singleQuote": true }\n', 'src/a.ts': "export const a = 'a';\n" };
    const messy = change(config, { 'src/a.ts': "export   const a='b'\n" });
    const format = check(at('lint.mjs'), messy);
    expect(format.ok).toBe(false);
    expect(format.out).toContain('oxfmt src/a.ts');
    const tidy = change(config, { 'src/a.ts': "export const a = 'b';\n", 'src/b.ts': 'export const b = 2;\n' });
    expect(check(at('lint.mjs'), tidy)).toEqual({ ok: true, out: 'lint: ok' });
  });
});

describe('safety check, repository hygiene', () => {
  it('fails harness memory, working notes, markdown outside the docs roots, a long file and a seed phrase', () => {
    const words = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
    const repo = change(
      { 'CHAT.md': 'short\n', 'kit/a.ts': 'export const a = 1;\n' },
      {
        'CHAT.md': `${'line\n'.repeat(120)}`,
        'kit/AGENTS.md': 'remember\n',
        'kit/.opencode/memory.json': '{}\n',
        'docs/review-notes.md': 'notes\n',
        'docs/scratch.mdx': 'scratch\n',
        'kit/src/wallet.ts': `const mnemonic = '${words}';\n`,
        'kit/src/wallet.test.ts': `const mnemonic = '${words}';\n`,
        'docs/content/docs/page.mdx': '# Page\n',
      }
    );
    const { ok, out } = check(
      'safety.mjs',
      repo,
      'kit/',
      'docs/',
      'CHAT.md',
      '--markdown',
      'docs/content/',
      '--max-lines',
      'CHAT.md:100'
    );
    expect(ok).toBe(false);
    expect(out.split('\n').slice(0, -1).sort()).toEqual([
      'CHAT.md: 120 lines; keep it under 100',
      'docs/review-notes.md: a new report or tracking file; put the outcome where the project keeps its records',
      'docs/scratch.mdx: a new markdown file outside docs/content/; keep working notes out of the repository',
      'kit/.opencode/memory.json: writes harness memory (.opencode/); propose a note instead',
      'kit/AGENTS.md: a new markdown file outside docs/content/; keep working notes out of the repository',
      'kit/AGENTS.md: writes harness memory (AGENTS.md); propose a note instead',
      'kit/src/wallet.ts:1: adds a seed phrase',
    ]);
    expect(out).not.toContain('legal winner');
  });
});

describe('clarinet reach check', () => {
  it('reads the brief from the issue context and the excuses from the reply, the files the engine writes', () => {
    const dir = tmp('engine-files');
    const brief = '## Title\nfeat(cli): x\n\n## Reach\n- CLI: `components/a.rs`';
    const at = '2026-10-13T09:01:00.000Z';
    const comment = { id: at, author: 'agentgraph[bot]', body: brief, at };
    const issue = {
      number: 1,
      title: 'X',
      body: 'Do x.',
      state: 'open' as const,
      labels: [],
      author: 'morgan',
      url: '',
    };
    const events = [{ issue: 1, kind: 'comment' as const, actor: 'agentgraph[bot]', trusted: true, at, comment }];
    writeFileSync(join(dir, 'context.md'), context({ issue: { ...issue, events } }));
    writeFileSync(join(dir, 'reply.md'), 'Done.\n\nNot reached: `components/a.rs`: a follow-up does it');
    const repo = change({ 'README.md': 'x\n' });
    const out = runScript(resolve(import.meta.dirname, '../examples/clarinet/scripts/reach.mjs'), repo, [], {
      AGENTGRAPH_CONTEXT: join(dir, 'context.md'),
      AGENTGRAPH_REPLY: join(dir, 'reply.md'),
    });
    expect(out.out.split('\n')[0]).toBe('components/a.rs (CLI) not reached: a follow-up does it');
  });
});

describe('clarinet toolchain checks', () => {
  const scripts = resolve(import.meta.dirname, '../examples/clarinet/scripts');
  const bare = { PATH: '/usr/bin:/bin', HOME: tmp('bare-home'), TMPDIR: tmp('bare-tmp') };

  it('exits 127 with the spawn error when cargo cannot start, so the run stops as an environment fault', () => {
    const r = spawnSync(process.execPath, [join(scripts, 'cargo.mjs'), 'fmt'], { encoding: 'utf8', env: bare });
    expect(r.status).toBe(127);
    expect(r.stdout).toMatch(/cargo could not start: .*ENOENT/);
  });

  it('exits 127 naming the missing tool before the SDK build starts', () => {
    const r = spawnSync('sh', [join(scripts, 'sdk.sh')], { encoding: 'utf8', env: bare, cwd: tmp('sdk-tree') });
    expect(r.status).toBe(127);
    expect(r.stdout).toMatch(/^sdk: \S+ not found$/m);
  });
});
