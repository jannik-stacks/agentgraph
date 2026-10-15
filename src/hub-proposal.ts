import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HubChange } from './apply.ts';
import { compile, type ConfigError, type SourceFile } from './config.ts';
import { botEnv, git } from './git.ts';
import { parseIssue } from './issues-local.ts';
import { readHub } from './load.ts';

/** Every hub file: what `readHub` reads, plus local issues under `issues/`. */
const readHubFiles = async (dir: string): Promise<SourceFile[]> => {
  const names = (await readdir(join(dir, 'issues')).catch(() => [])).filter(n => n.endsWith('.md')).sort();
  const issues = await Promise.all(
    names.map(async name => ({ path: `issues/${name}`, source: await readFile(join(dir, 'issues', name), 'utf8') }))
  );
  return [...(await readHub(dir)), ...issues];
};

/** What is wrong with a hub made of `files`: config errors, and issue files that do not parse or share a number. */
const hubErrors = (files: SourceFile[]): ConfigError[] => {
  const errors: ConfigError[] = [];
  const numbers = new Map<number, string>();
  for (const file of files.filter(f => f.path.startsWith('issues/'))) {
    try {
      const { number } = parseIssue(file.path.slice('issues/'.length), file.source);
      const other = numbers.get(number);
      if (other) errors.push({ path: file.path, message: `has the same number as ${other}` });
      numbers.set(number, file.path);
    } catch (e) {
      errors.push({ path: file.path, message: (e as Error).message });
    }
  }
  const compiled = compile(files.filter(f => !f.path.startsWith('issues/')));
  return compiled.ok ? errors : [...errors, ...compiled.errors];
};

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
      ...(await readHubFiles(dir)).filter(file => !changed.has(file.path)),
      ...files.flatMap(file => (file.content === null ? [] : [{ path: file.path, source: file.content }])),
    ];
    const errors = hubErrors(after);
    if (errors.length)
      throw new Error(`the change leaves the hub invalid: ${errors.map(e => `${e.path}: ${e.message}`).join('; ')}`);
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
