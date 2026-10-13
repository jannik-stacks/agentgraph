import { randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { z } from 'zod';
import type { HubChange } from './apply.ts';
import type { ConfigError, SourceFile } from './config.ts';
import { botEnv, git } from './git.ts';
import { applyChanges, itemKind, validateHub, type Change } from './hub-files.ts';
import { readHub } from './load.ts';

/** Every hub item file: what `readHub` reads, plus local issues under `issues/`. */
export const readHubItems = async (dir: string): Promise<SourceFile[]> => {
  const names = (await readdir(join(dir, 'issues')).catch(() => [])).filter(n => n.endsWith('.md')).sort();
  const issues = await Promise.all(
    names.map(async name => ({ path: `issues/${name}`, source: await readFile(join(dir, 'issues', name), 'utf8') }))
  );
  return [...(await readHub(dir)), ...issues];
};

const maxSource = 256 * 1024;

const ChangeInput = z.union([
  z.strictObject({
    path: z.string(),
    data: z.record(z.string(), z.unknown()),
    body: z.string().max(maxSource).optional(),
    base: z.string().nullable().optional(),
  }),
  z.strictObject({ path: z.string(), delete: z.literal(true), base: z.string().nullable().optional() }),
]);
const WriteInput = z.strictObject({ changes: z.array(ChangeInput).min(1).max(200), commit: z.boolean().optional() });
export type WriteInput = z.input<typeof WriteInput>;

export type WriteResult =
  | { ok: true; written: string[]; deleted: string[]; commit?: string; commitError?: string }
  | { ok: false; status: 400 | 409 | 422; errors: ConfigError[] };

const refuse = (status: 400 | 409 | 422, errors: ConfigError[]): WriteResult => ({ ok: false, status, errors });

/**
 * Resolves a hub-relative item path to an absolute one inside `base`. Refuses paths no item may live at and any
 * existing symlink or non-directory along the way, so a write can never leave the hub.
 */
const confine = async (base: string, path: string) => {
  if (!itemKind(path)) throw new Error('is not a path a hub item may live at');
  const parts = path.split('/');
  let at = base;
  for (const [i, part] of parts.entries()) {
    at = join(at, part);
    const info = await lstat(at).catch(() => undefined);
    if (!info) continue;
    if (info.isSymbolicLink()) throw new Error('goes through a symlink');
    if (i < parts.length - 1 ? !info.isDirectory() : !info.isFile()) throw new Error('is not a regular file');
  }
  return at;
};

const current = (path: string) => readFile(path, 'utf8').catch(() => null);

const isGitRepo = (dir: string) =>
  git(dir, ['rev-parse', '--is-inside-work-tree']).then(
    out => out === 'true',
    () => false
  );

/** Whether the hub directory is inside a git work tree, so saved changes can be committed. */
export const hubGit = async (dir: string) => ({ repo: await isGitRepo(dir) });

let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(task: () => Promise<T>) => {
  const next = queue.catch(() => {}).then(task);
  queue = next;
  return next;
};

/**
 * Writes item changes into a hub directory. Every path is confined to the hub's item folders, each change may name
 * the `base` text it was made against (`null` for a file that must not exist yet), and the whole hub is validated
 * as it would be after the write; any problem writes nothing. Files are written to a temporary name and renamed into
 * place. With `commit`, the changed paths are committed as `update` when the hub is in a git work tree.
 */
export const writeHub = (dir: string, input: unknown): Promise<WriteResult> =>
  serial(async () => {
    const parsed = WriteInput.safeParse(input);
    if (!parsed.success) return refuse(400, [{ path: '', message: z.prettifyError(parsed.error) }]);
    const { changes, commit } = parsed.data;
    const base = await realpath(dir).catch(() => undefined);
    if (!base) return refuse(400, [{ path: dir, message: 'hub directory does not exist' }]);

    const targets = new Map<string, string>();
    const errors: ConfigError[] = [];
    for (const change of changes) {
      if (targets.has(change.path)) errors.push({ path: change.path, message: 'is changed twice' });
      try {
        targets.set(change.path, await confine(base, change.path));
      } catch (e) {
        errors.push({ path: change.path, message: (e as Error).message });
      }
    }
    if (errors.length) return refuse(400, errors);

    for (const change of changes) {
      if (change.base === undefined) continue;
      if ((await current(targets.get(change.path)!)) !== change.base)
        errors.push({ path: change.path, message: 'changed on disk since it was loaded' });
    }
    if (errors.length) return refuse(409, errors);

    const before = await readHubItems(base);
    const after = applyChanges(before, changes as Change[]);
    const validated = validateHub(after);
    if (!validated.ok) return refuse(422, validated.errors);

    const sources = new Map(after.map(f => [f.path, f.source]));
    const old = new Map(before.map(f => [f.path, f.source]));
    const writes = changes.filter(c => !('delete' in c) && sources.get(c.path) !== old.get(c.path));
    const deletes = changes.filter(c => 'delete' in c && old.has(c.path));

    const temps: [string, string][] = [];
    try {
      for (const change of writes) {
        const target = targets.get(change.path)!;
        await mkdir(dirname(target), { recursive: true });
        const parent = await realpath(dirname(target));
        if (parent !== base && !parent.startsWith(base + sep)) throw new Error(`${change.path} leaves the hub`);
        const temp = join(parent, `.${change.path.split('/').pop()}.${randomBytes(6).toString('hex')}.tmp`);
        await writeFile(temp, sources.get(change.path)!, { flag: 'wx' });
        temps.push([temp, target]);
      }
    } catch (e) {
      await Promise.all(temps.map(([temp]) => rm(temp, { force: true })));
      return refuse(400, [{ path: '', message: (e as Error).message }]);
    }
    for (const [temp, target] of temps) await rename(temp, target);
    for (const change of deletes) await rm(targets.get(change.path)!);

    const result: WriteResult = {
      ok: true,
      written: writes.map(c => c.path),
      deleted: deletes.map(c => c.path),
    };
    const touched = [...result.written, ...result.deleted];
    if (commit && touched.length && (await isGitRepo(base))) {
      try {
        const tracked = (await git(base, ['ls-files', '--', ...result.deleted])).split('\n');
        const paths = [...result.written, ...result.deleted.filter(path => tracked.includes(path))];
        if (result.written.length) await git(base, ['add', '--', ...result.written]);
        if (paths.length) {
          await git(base, ['commit', '-m', 'update', '--only', '--', ...paths]);
          result.commit = await git(base, ['rev-parse', 'HEAD']);
        }
      } catch (e) {
        result.commitError = (e as Error).message;
      }
    }
    return result;
  });

const branchSlug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '') || 'change';

/**
 * Lands a hub change on a new branch `bothub/hub/<slug>-<sha>` of the hub's own repository, made from its HEAD, for a
 * human to merge. The working tree and the checked-out branch are never touched, and a change that would leave the
 * hub invalid is refused. Resolves to the branch, or to nothing when the hub directory is not the top of a repository.
 */
export const hubProposal =
  (dir: string) =>
  async ({ files, title, body }: HubChange): Promise<string | undefined> => {
    const top = await git(dir, ['rev-parse', '--show-toplevel']).then(realpath, () => undefined);
    if (!top || top !== (await realpath(dir))) return;
    const changed = new Set(files.map(file => file.path));
    const after = [
      ...(await readHubItems(dir)).filter(file => !changed.has(file.path)),
      ...files.flatMap(file => (file.content === null ? [] : [{ path: file.path, source: file.content }])),
    ];
    const validated = validateHub(after);
    if (!validated.ok)
      throw new Error(
        `the change leaves the hub invalid: ${validated.errors.map(e => `${e.path}: ${e.message}`).join('; ')}`
      );
    const scratch = await mkdtemp(join(tmpdir(), 'bothub-hub-'));
    const env = { ...botEnv, GIT_INDEX_FILE: join(scratch, 'index') };
    const inTop = (args: string[]) => git(top, args, env);
    try {
      await inTop(['read-tree', 'HEAD']);
      for (const file of files) {
        if (file.content === null) {
          await inTop(['update-index', '--force-remove', '--', file.path]);
          continue;
        }
        const blob = join(scratch, 'blob');
        await writeFile(blob, file.content);
        const sha = await inTop(['hash-object', '-w', '--', blob]);
        await inTop(['update-index', '--add', '--cacheinfo', `100644,${sha},${file.path}`]);
      }
      const tree = await inTop(['write-tree']);
      const commit = await inTop([
        'commit-tree',
        '--no-gpg-sign',
        tree,
        '-p',
        'HEAD',
        '-m',
        body.trim() ? `${title}\n\n${body}` : title,
      ]);
      const branch = `bothub/hub/${branchSlug(title)}-${commit.slice(0, 7)}`;
      await inTop(['update-ref', `refs/heads/${branch}`, commit, '']);
      return branch;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };

const loopback = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const isLocal = (req: Request) => {
  const url = new URL(req.url);
  if (!loopback.has(url.hostname)) return false;
  const origin = req.headers.get('origin');
  if (origin === null) return true;
  try {
    return loopback.has(new URL(origin).hostname);
  } catch {
    return false;
  }
};

const maxBody = 2 * 1024 * 1024;

/**
 * Hub editing routes for the studio API. `GET /api/hub/items` lists every item file and whether the hub is in git;
 * `POST /api/hub/validate` checks changes without writing; `POST /api/hub/write` writes them (see `writeHub`).
 * Writes answer only requests addressed to a loopback host, from a loopback origin, with a JSON body.
 * Returns `undefined` for paths it does not own.
 */
export const hubWriteRoutes =
  (hubDir: string) =>
  async (req: Request): Promise<Response | undefined> => {
    const { pathname } = new URL(req.url);
    if (pathname === '/api/hub/items') {
      if (req.method !== 'GET') return Response.json({ error: 'method not allowed' }, { status: 405 });
      return Response.json({ files: await readHubItems(hubDir), git: (await hubGit(hubDir)).repo });
    }
    if (pathname !== '/api/hub/write' && pathname !== '/api/hub/validate') return;
    if (req.method !== 'POST') return Response.json({ error: 'method not allowed' }, { status: 405 });
    if (!isLocal(req)) return Response.json({ error: 'hub edits are only served on localhost' }, { status: 403 });
    if (!req.headers.get('content-type')?.startsWith('application/json'))
      return Response.json({ error: 'expected a JSON body' }, { status: 415 });
    const text = await req.text();
    if (text.length > maxBody) return Response.json({ error: 'body too large' }, { status: 413 });
    let input: unknown;
    try {
      input = JSON.parse(text);
    } catch {
      return Response.json({ error: 'body is not JSON' }, { status: 400 });
    }
    if (pathname === '/api/hub/validate') {
      const parsed = WriteInput.safeParse(input);
      if (!parsed.success)
        return Response.json(
          { ok: false, errors: [{ path: '', message: z.prettifyError(parsed.error) }] },
          { status: 400 }
        );
      const unplaced = parsed.data.changes.filter(c => !itemKind(c.path));
      if (unplaced.length)
        return Response.json({
          ok: false,
          errors: unplaced.map(c => ({ path: c.path, message: 'is not a path a hub item may live at' })),
        });
      const { ok, errors, warnings } = validateHub(
        applyChanges(await readHubItems(hubDir), parsed.data.changes as Change[])
      );
      return Response.json({ ok, errors, warnings });
    }
    const result = await writeHub(hubDir, input);
    return result.ok
      ? Response.json(result)
      : Response.json({ ok: false, errors: result.errors }, { status: result.status });
  };
