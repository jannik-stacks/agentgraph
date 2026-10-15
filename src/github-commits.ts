import { execFile } from 'node:child_process';
import type { GitHub, GitHubError } from './github-app.ts';

const raw = (cwd: string, args: string[]) =>
  new Promise<Buffer>((resolve, reject) =>
    execFile(
      'git',
      ['-C', cwd, ...args],
      { encoding: 'buffer', maxBuffer: 256 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (error, stdout, stderr) =>
        error
          ? reject(new Error(`git ${args.join(' ')} failed: ${stderr.toString().trim() || error.message}`))
          : resolve(stdout)
    )
  );

const text = async (cwd: string, args: string[]) => (await raw(cwd, args)).toString('utf8').trim();

const missing = (e: GitHubError) => {
  if (e.status !== 404) throw e;
  return undefined;
};

type Entry = { path: string; mode: string; type: 'blob' | 'commit'; sha: string | null };

const deleted = '000000';
const gitlink = '160000';

/** The tree entries that turn `parent`'s tree into `commit`'s, uploading each changed blob. */
const entries = async (gh: GitHub, api: string, cwd: string, parent: string, commit: string) => {
  const fields = (await raw(cwd, ['diff-tree', '-r', '-z', '--no-renames', '--no-abbrev', parent, commit]))
    .toString('utf8')
    .split('\0');
  const changed: Entry[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [oldMode, newMode, oldSha, newSha] = fields[i]!.slice(1).split(' ') as [string, string, string, string];
    const path = fields[i + 1]!;
    if (newMode === deleted)
      changed.push({ path, mode: oldMode, type: oldMode === gitlink ? 'commit' : 'blob', sha: null });
    else if (newMode === gitlink || oldSha === newSha)
      changed.push({ path, mode: newMode, type: newMode === gitlink ? 'commit' : 'blob', sha: newSha });
    else {
      const content = (await raw(cwd, ['cat-file', 'blob', newSha])).toString('base64');
      const { sha } = await gh<{ sha: string }>('POST', `${api}/git/blobs`, { content, encoding: 'base64' });
      if (sha !== newSha) throw new Error(`GitHub stored ${path} as ${sha}, expected ${newSha}`);
      changed.push({ path, mode: newMode, type: 'blob', sha });
    }
  }
  return changed;
};

const refPath = (branch: string) => {
  const parts = branch.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error(`invalid branch "${branch}"`);
  return `heads/${parts.map(encodeURIComponent).join('/')}`;
};

/**
 * Pushes the commits in `cwd` from `HEAD` back to what GitHub already has onto `branch` through the Git data API, one
 * API commit per local commit with the same tree, parents and message. GitHub signs them as the App, so they show as
 * verified. Walks back from `HEAD` until it reaches commits GitHub already has. The branch only moves forward; with `replace` it is replaced instead, only while it is still at that
 * commit. `committed` gets the new head before the branch moves. Resolves to the new head.
 */
export const pushCommits = async (
  gh: GitHub,
  {
    repo,
    cwd,
    branch,
    replace,
    committed,
  }: { repo: string; cwd: string; branch: string; replace?: string; committed?: (sha: string) => Promise<unknown> }
): Promise<string> => {
  const api = `/repos/${repo}`;
  const ref = `${api}/git/refs/${refPath(branch)}`;
  const tip = (await gh<{ object: { sha: string } }>('GET', `${api}/git/ref/${refPath(branch)}`).catch(missing))
    ?.object.sha;
  if (replace && tip !== replace) throw new Error(`branch "${branch}" moved since this run started from it`);

  const remote = new Map<string, string>();
  const replay = async (commit: string): Promise<string> => {
    const known = remote.get(commit);
    if (known) return known;
    if (await gh('GET', `${api}/git/commits/${commit}`).catch(missing)) return remote.set(commit, commit).get(commit)!;
    const [tree, ...parents] = (await text(cwd, ['log', '-1', '--format=%T %P', commit])).split(' ') as [string, ...string[]];
    const [first] = parents;
    if (!first) throw new Error(`commit ${commit} has no parent on GitHub; push the first commit with git`);
    const onGitHub = [];
    for (const parent of parents) onGitHub.push(await replay(parent));
    const changed = await entries(gh, api, cwd, first, commit);
    const base = await text(cwd, ['rev-parse', `${first}^{tree}`]);
    const made = changed.length
      ? (await gh<{ sha: string }>('POST', `${api}/git/trees`, { base_tree: base, tree: changed })).sha
      : base;
    if (made !== tree) throw new Error(`GitHub built tree ${made} for ${commit}, expected ${tree}`);
    const message = (await raw(cwd, ['log', '-1', '--format=%B', commit])).toString('utf8').replace(/\n+$/, '\n');
    const { sha } = await gh<{ sha: string }>('POST', `${api}/git/commits`, { message, tree, parents: onGitHub });
    return remote.set(commit, sha).get(commit)!;
  };

  const head = await replay(await text(cwd, ['rev-parse', 'HEAD']));
  if (head === tip) return head;
  await committed?.(head);
  if (tip) await gh('PATCH', ref, { sha: head, force: !!replace });
  else await gh('POST', `${api}/git/refs`, { ref: `refs/heads/${branch}`, sha: head });
  return head;
};
