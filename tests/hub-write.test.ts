import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { api } from '../src/api.ts';
import { parseItem, renderItem, validateHub } from '../src/hub-files.ts';
import { hubWriteRoutes, readHubItems, writeHub } from '../src/hub-write.ts';
import { openStore } from '../src/store.ts';

const example = join(import.meta.dirname, '..', 'examples', 'acme-app');

const temp = () => mkdtempSync(join(tmpdir(), 'bothub-hub-write-'));

const exampleHub = () => {
  const dir = temp();
  cpSync(example, dir, { recursive: true });
  return dir;
};

const minimalHub = () => {
  const dir = temp();
  mkdirSync(join(dir, 'skills'));
  writeFileSync(join(dir, 'skills', 'triage.md'), '---\ndescription: Triage.\n---\nRead the issue.\n');
  return dir;
};

const tree = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile())
    .map(e => join(e.parentPath, e.name).slice(dir.length + 1))
    .sort();

const bot = { harness: 'opencode', tools: ['read'], can: ['reply'], skills: ['triage'] };

describe('writeHub path confinement', () => {
  const attacks = [
    '../escape.md',
    'bots/../../escape.md',
    'bots/../hub.yaml/../../escape.md',
    '/etc/passwd',
    'bots/x.txt',
    'bots/a/b.md',
    'scripts/run.md',
    'notes/secrets/x.md',
    'notes/decision/../../../escape.md',
    'issues/no-number.md',
    'bots/UPPER.md',
    '.git/config',
    'hub.yml',
  ];
  it.each(attacks)('refuses %s and writes nothing', async path => {
    const dir = minimalHub();
    const before = tree(dir);
    const result = await writeHub(dir, { changes: [{ path, data: bot, body: 'x' }] });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(tree(dir)).toEqual(before);
    expect(existsSync(join(dir, '..', 'escape.md'))).toBe(false);
  });

  it('refuses to write through a symlinked folder', async () => {
    const dir = minimalHub();
    const outside = temp();
    symlinkSync(outside, join(dir, 'bots'));
    const result = await writeHub(dir, { changes: [{ path: 'bots/triager.md', data: bot, body: 'Role.' }] });
    expect(result).toMatchObject({ ok: false, status: 400, errors: [{ message: 'goes through a symlink' }] });
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses to overwrite or delete a symlinked file', async () => {
    const dir = minimalHub();
    const outside = join(temp(), 'target.md');
    writeFileSync(outside, 'keep me');
    mkdirSync(join(dir, 'bots'));
    symlinkSync(outside, join(dir, 'bots', 'triager.md'));
    for (const change of [
      { path: 'bots/triager.md', data: bot, body: 'Role.' },
      { path: 'bots/triager.md', delete: true },
    ])
      expect(await writeHub(dir, { changes: [change] })).toMatchObject({ ok: false, status: 400 });
    expect(readFileSync(outside, 'utf8')).toBe('keep me');
  });

  it('refuses unknown fields in a change and malformed input', async () => {
    const dir = minimalHub();
    expect(await writeHub(dir, { changes: [{ path: 'bots/a.md', data: bot, mode: 0o777 }] })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(await writeHub(dir, { changes: [] })).toMatchObject({ ok: false, status: 400 });
    expect(await writeHub(dir, 'bots/a.md')).toMatchObject({ ok: false, status: 400 });
  });
});

describe('writeHub validation', () => {
  it('rejects a change that breaks the hub and writes no file of the batch', async () => {
    const dir = minimalHub();
    const before = tree(dir);
    const result = await writeHub(dir, {
      changes: [
        { path: 'bots/triager.md', data: bot, body: 'Role.' },
        { path: 'bots/broken.md', data: { ...bot, skills: ['missing'] }, body: 'Role.' },
      ],
    });
    expect(result).toMatchObject({
      ok: false,
      status: 422,
      errors: [{ path: 'bots/broken.md', message: 'offers unknown skill "missing"' }],
    });
    expect(tree(dir)).toEqual(before);
  });

  it('rejects frontmatter that does not fit the kind', async () => {
    const dir = minimalHub();
    const result = await writeHub(dir, {
      changes: [{ path: 'skills/triage.md', data: { description: '', extra: 1 } }],
    });
    expect(result).toMatchObject({ ok: false, status: 422 });
    expect(readFileSync(join(dir, 'skills', 'triage.md'), 'utf8')).toContain('description: Triage.');
  });

  it('rejects deleting a skill that is still referenced', async () => {
    const dir = exampleHub();
    const result = await writeHub(dir, { changes: [{ path: 'skills/triage.md', delete: true }] });
    expect(result).toMatchObject({ ok: false, status: 422 });
    expect(existsSync(join(dir, 'skills', 'triage.md'))).toBe(true);
  });

  it('rejects an invalid local issue', async () => {
    const dir = exampleHub();
    const result = await writeHub(dir, { changes: [{ path: 'issues/9-x.md', data: { title: '', state: 'maybe' } }] });
    expect(result).toMatchObject({ ok: false, status: 422, errors: [{ path: 'issues/9-x.md' }] });
    expect(existsSync(join(dir, 'issues', '9-x.md'))).toBe(false);
  });

  it('refuses a change made against text that has since changed on disk', async () => {
    const dir = minimalHub();
    const result = await writeHub(dir, {
      changes: [{ path: 'skills/triage.md', data: { description: 'New.' }, base: 'stale text' }],
    });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(
      await writeHub(dir, { changes: [{ path: 'skills/new.md', data: { description: 'A.' }, base: 'x' }] })
    ).toMatchObject({
      ok: false,
      status: 409,
    });
  });
});

describe('writeHub round trip', () => {
  it('edits one field and keeps the body and every other key', async () => {
    const dir = exampleHub();
    const path = 'workflows/issue.md';
    const original = readFileSync(join(dir, path), 'utf8');
    const loaded = (await readHubItems(dir)).find(f => f.path === path)!;
    const item = parseItem(path, loaded.source);
    const jobs = item.data.jobs as Record<string, Record<string, unknown>>;
    jobs.triage!.mode = 'block';

    const result = await writeHub(dir, { changes: [{ path, data: item.data, body: item.body, base: original }] });
    expect(result).toMatchObject({ ok: true, written: [path] });

    const saved = readFileSync(join(dir, path), 'utf8');
    const reloaded = parseItem(path, saved);
    expect(reloaded.body).toBe(parseItem(path, original).body);
    expect(saved.endsWith(`${reloaded.body}\n`)).toBe(true);
    const expected = parseItem(path, original).data as { jobs: Record<string, Record<string, unknown>> };
    expected.jobs.triage!.mode = 'block';
    expect(reloaded.data).toEqual(expected);
    expect(Object.keys(reloaded.data)).toEqual(['name', 'description', 'on', 'jobs']);
    const changed = saved.split('\n').filter((line, i) => line !== original.split('\n')[i]);
    expect(changed).toEqual(['    guard: {associations: [OWNER, MEMBER, COLLABORATOR]}', '    mode: block']);
    expect(validateHub(await readHubItems(dir)).ok).toBe(true);
  });

  it('keeps the frontmatter text, comments included, when only the body changes', async () => {
    const dir = minimalHub();
    const path = 'skills/triage.md';
    writeFileSync(join(dir, path), '---\n# why this skill exists\ndescription: Triage.\n---\nOld prompt.\n');
    const result = await writeHub(dir, { changes: [{ path, data: { description: 'Triage.' }, body: 'New prompt.' }] });
    expect(result).toMatchObject({ ok: true });
    expect(readFileSync(join(dir, path), 'utf8')).toBe(
      '---\n# why this skill exists\ndescription: Triage.\n---\nNew prompt.\n'
    );
  });

  it('edits frontmatter in place, keeping comments, key order and style of what did not change', async () => {
    const dir = minimalHub();
    const path = 'checks/lint.md';
    mkdirSync(join(dir, 'checks'));
    writeFileSync(
      join(dir, path),
      '---\n# runs in CI too\nmode: warn\nrun: npm run lint  # fast\npaths: [src/**]\n---\nBody.\n'
    );
    const result = await writeHub(dir, {
      changes: [
        { path, data: { mode: 'block', run: 'npm run lint', paths: ['src/**'], description: 'Lint.' }, body: 'Body.' },
      ],
    });
    expect(result).toMatchObject({ ok: true });
    expect(readFileSync(join(dir, path), 'utf8')).toBe(
      '---\n# runs in CI too\nmode: block\nrun: npm run lint # fast\npaths: [src/**]\ndescription: Lint.\n---\nBody.\n'
    );
  });

  it('writes nothing for a change that leaves the file as it is', async () => {
    const dir = exampleHub();
    const path = 'bots/triager.md';
    const original = readFileSync(join(dir, path), 'utf8');
    const result = await writeHub(dir, { changes: [{ path, ...parseItem(path, original) }] });
    expect(result).toEqual({ ok: true, written: [], deleted: [] });
    expect(readFileSync(join(dir, path), 'utf8')).toBe(original);
  });

  it('serialises in schema key order no matter the input order, keeping keys it does not know last', () => {
    const path = 'bots/a.md';
    const a = renderItem(path, {
      data: { can: ['reply'], extra: { z: 1 }, tools: ['read'], harness: 'pi' },
      body: 'Hi.',
    });
    const b = renderItem(path, {
      data: { harness: 'pi', tools: ['read'], extra: { z: 1 }, can: ['reply'] },
      body: 'Hi.',
    });
    expect(a).toBe(b);
    expect(a).toBe('---\nharness: pi\ntools: [read]\ncan: [reply]\nextra: {z: 1}\n---\n\nHi.\n');
  });

  it('creates, renames and deletes in one batch', async () => {
    const dir = minimalHub();
    const create = await writeHub(dir, {
      changes: [
        { path: 'bots/triager.md', data: bot, body: 'Role.', base: null },
        { path: 'notes/caveat/first.md', data: { title: 'First' }, body: 'Body.' },
        { path: 'hub.yaml', data: { issues: 'local' } },
        { path: 'issues/1-start.md', data: { title: 'Start' }, body: 'Do it.' },
      ],
    });
    expect(create).toMatchObject({ ok: true });
    expect(readFileSync(join(dir, 'hub.yaml'), 'utf8')).toBe('issues: local\n');
    const rename = await writeHub(dir, {
      changes: [
        { path: 'bots/triager.md', delete: true },
        { path: 'bots/sorter.md', data: bot, body: 'Role.' },
      ],
    });
    expect(rename).toMatchObject({ ok: true, written: ['bots/sorter.md'], deleted: ['bots/triager.md'] });
    expect(tree(dir)).toEqual([
      'bots/sorter.md',
      'hub.yaml',
      'issues/1-start.md',
      'notes/caveat/first.md',
      'skills/triage.md',
    ]);
  });
});

describe('writeHub atomic writes', () => {
  it('leaves no temporary files behind', async () => {
    const dir = exampleHub();
    await writeHub(dir, { changes: [{ path: 'bots/extra.md', data: bot, body: 'Role.' }] });
    expect(tree(dir).filter(p => p.endsWith('.tmp'))).toEqual([]);
  });

  it('writes no file of a batch when one cannot be written', async () => {
    const dir = minimalHub();
    mkdirSync(join(dir, 'checks'));
    chmodSync(join(dir, 'checks'), 0o555);
    try {
      const result = await writeHub(dir, {
        changes: [
          { path: 'bots/triager.md', data: bot, body: 'Role.' },
          { path: 'checks/lint.md', data: { run: 'true' } },
        ],
      });
      expect(result).toMatchObject({ ok: false, status: 400 });
      expect(tree(dir)).toEqual(['skills/triage.md']);
      expect(readdirSync(join(dir, 'bots'))).toEqual([]);
    } finally {
      chmodSync(join(dir, 'checks'), 0o755);
    }
  });
});

describe('writeHub commit', () => {
  const git = (dir: string, ...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

  it('commits only the changed paths as "update" when the hub is a git repository', async () => {
    const dir = minimalHub();
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.name', 'test');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, 'unrelated.txt'), 'staged elsewhere');
    git(dir, 'add', 'unrelated.txt');
    const result = await writeHub(dir, {
      changes: [{ path: 'bots/triager.md', data: bot, body: 'Role.' }],
      commit: true,
    });
    expect(result).toMatchObject({ ok: true });
    expect(git(dir, 'log', '--format=%s')).toBe('update');
    expect(git(dir, 'show', '--name-only', '--format=')).toBe('bots/triager.md');
    expect(git(dir, 'diff', '--cached', '--name-only')).toBe('unrelated.txt');
  });

  it('commits only the saved hub files when the hub is a folder of a repository with other dirty files', async () => {
    const repo = temp();
    const dir = join(repo, 'hub');
    mkdirSync(join(dir, 'skills'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'triage.md'), '---\ndescription: Triage.\n---\nRead the issue.\n');
    writeFileSync(join(dir, 'skills', 'other.md'), '---\ndescription: Other.\n---\n');
    writeFileSync(join(repo, 'outside.txt'), 'v1');
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.name', 'test');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'commit.gpgsign', 'false');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    writeFileSync(join(repo, 'outside.txt'), 'v2');
    writeFileSync(join(dir, 'skills', 'other.md'), '---\ndescription: Edited by hand.\n---\n');
    writeFileSync(join(dir, 'untracked.md'), 'scratch');
    git(repo, 'add', 'outside.txt');
    const dirty = 'M hub/skills/other.md\nM  outside.txt\n?? hub/untracked.md';

    const result = await writeHub(dir, {
      changes: [
        { path: 'bots/triager.md', data: bot, body: 'Role.' },
        { path: 'skills/triage.md', data: { description: 'Triage issues.' }, body: 'Read the issue.' },
      ],
      commit: true,
    });
    expect(result).toMatchObject({ ok: true, commit: expect.any(String) });
    expect(git(repo, 'show', '--name-only', '--format=%s').split('\n')).toEqual([
      'update',
      '',
      'hub/bots/triager.md',
      'hub/skills/triage.md',
    ]);
    expect(git(repo, 'status', '--porcelain')).toBe(dirty);

    const removed = await writeHub(dir, { changes: [{ path: 'bots/triager.md', delete: true }], commit: true });
    expect(removed).toMatchObject({ ok: true, deleted: ['bots/triager.md'] });
    expect(git(repo, 'show', '--name-status', '--format=')).toBe('D\thub/bots/triager.md');
    expect(git(repo, 'status', '--porcelain')).toBe(dirty);
  });

  it('only saves when the hub is not a git repository', async () => {
    const dir = minimalHub();
    const result = await writeHub(dir, {
      changes: [{ path: 'bots/triager.md', data: bot, body: 'Role.' }],
      commit: true,
    });
    expect(result).toEqual({ ok: true, written: ['bots/triager.md'], deleted: [] });
  });
});

describe('hub edit routes', () => {
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const change = { changes: [{ path: 'bots/triager.md', data: bot, body: 'Role.' }] };

  it('lists item files with local issues', async () => {
    const handler = api({ hubDir: exampleHub(), store: openStore(temp()) });
    const res = await handler(new Request('http://127.0.0.1/api/hub/items'));
    const { files, git } = (await res.json()) as { files: { path: string }[]; git: boolean };
    expect(files.map(f => f.path)).toContain('issues/4-clarity-values-round-trip-through-json.md');
    expect(files.map(f => f.path)).toContain('workflows/issue.md');
    expect(typeof git).toBe('boolean');
  });

  it('validates without writing', async () => {
    const dir = minimalHub();
    const route = hubWriteRoutes(dir);
    const res = await route(
      post('http://127.0.0.1:5181/api/hub/validate', {
        changes: [{ path: 'bots/b.md', data: { ...bot, skills: ['nope'] } }],
      })
    );
    expect(await res!.json()).toMatchObject({ ok: false, errors: [{ path: 'bots/b.md' }] });
    expect(existsSync(join(dir, 'bots'))).toBe(false);
  });

  it.each([
    ['a non-loopback host', 'http://192.168.1.5:5181/api/hub/write', {}],
    ['a cross-site origin', 'http://127.0.0.1:5181/api/hub/write', { origin: 'https://evil.example' }],
  ])('refuses %s', async (_, url, headers) => {
    const dir = minimalHub();
    const res = await hubWriteRoutes(dir)(post(url, change, headers));
    expect(res!.status).toBe(403);
    expect(existsSync(join(dir, 'bots'))).toBe(false);
  });

  it('refuses a body that is not JSON-typed', async () => {
    const dir = minimalHub();
    const req = new Request('http://localhost:5182/api/hub/write', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify(change),
    });
    expect((await hubWriteRoutes(dir)(req))!.status).toBe(415);
  });

  it('writes through the studio api from a localhost origin', async () => {
    const dir = minimalHub();
    const handler = api({ hubDir: dir, store: openStore(temp()) });
    const res = await handler(post('http://localhost:5182/api/hub/write', change, { origin: 'http://localhost:5182' }));
    expect(res.status).toBe(200);
    expect(readFileSync(join(dir, 'bots', 'triager.md'), 'utf8')).toBe(
      '---\nharness: opencode\ntools: [read]\ncan: [reply]\nskills: [triage]\n---\n\nRole.\n'
    );
    expect((await handler(post('http://localhost/api/files', {}))).status).toBe(405);
  });
});
