import { chmodSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gh } from '../src/github-app.ts';
import { pushCommits } from '../src/github-commits.ts';
import { fakeGitHub } from './github-fake.ts';
import { commit, git, sourceRepo, temp } from './kit.ts';

const setup = () => {
  const remote = sourceRepo();
  const local = join(temp('local'), 'app');
  git(temp('clone'), 'clone', '-q', remote.dir, local);
  const github = fakeGitHub(remote.dir);
  return { remote, local, github, client: gh('token', github.fetch) };
};

describe('pushCommits', () => {
  it('replays each local commit with its tree, modes, binaries, merges and message, as the App', async () => {
    const { remote, local, github, client } = setup();
    git(local, 'checkout', '-qb', 'work');
    writeFileSync(join(local, 'bin.dat'), Buffer.from([0, 1, 2, 255, 0, 10, 13]));
    writeFileSync(join(local, 'run.sh'), '#!/bin/sh\necho hi\n');
    chmodSync(join(local, 'run.sh'), 0o755);
    symlinkSync('README.md', join(local, 'link'));
    git(local, 'add', '.');
    git(local, 'commit', '-qm', 'add files\n\nwith a body');
    commit(local, { 'docs/a b.md': 'spaced\n' });
    rmSync(join(local, 'bin.dat'));
    chmodSync(join(local, 'run.sh'), 0o644);
    git(local, 'add', '-A');
    git(local, 'commit', '-qm', 'drop the binary, unset exec');
    git(local, 'merge', '-q', '--no-ff', '-m', 'merge feature', 'origin/feature');
    const seen: string[] = [];

    const head = await pushCommits(client, {
      repo: 'acme/app',
      cwd: local,
      branch: 'bothub/1',
      committed: async sha => seen.push(sha, git(remote.dir, 'branch', '--list', 'bothub/1')),
    });

    expect(seen).toEqual([head, '']);
    expect(git(remote.dir, 'rev-parse', 'bothub/1')).toBe(head);
    expect(git(remote.dir, 'rev-parse', 'bothub/1^{tree}')).toBe(git(local, 'rev-parse', 'HEAD^{tree}'));
    expect(git(remote.dir, 'log', '--topo-order', '--format=%s', 'main..bothub/1')).toBe(
      git(local, 'log', '--topo-order', '--format=%s', 'main..HEAD')
    );
    expect(git(remote.dir, 'log', '-1', '--format=%B', 'bothub/1~3')).toBe('add files\n\nwith a body');
    expect(git(remote.dir, 'rev-parse', 'bothub/1^2')).toBe(remote.feature);
    expect(git(remote.dir, 'ls-tree', 'bothub/1~3', 'run.sh', 'link', 'bin.dat')).toMatch(
      /^100644 blob \S+\tbin.dat\n120000 blob \S+\tlink\n100755 blob \S+\trun.sh$/
    );
    const commits = github.calls.filter(c => c.method === 'POST' && c.path === '/git/commits');
    expect(commits).toHaveLength(4);
    for (const c of commits) expect(Object.keys(c.body!).sort()).toEqual(['message', 'parents', 'tree']);
    expect(github.calls.filter(c => c.path === '/git/blobs').map(c => c.body?.encoding)).toEqual(Array(5).fill('base64'));
  });

  it('moves an existing branch forward only, and replaces it only from the commit it started at', async () => {
    const { remote, local, client } = setup();
    git(local, 'checkout', '-q', '-b', 'feature', 'origin/feature');
    const ahead = commit(local, { 'more.txt': 'more\n' });
    const head = await pushCommits(client, { repo: 'acme/app', cwd: local, branch: 'feature' });
    expect(git(remote.dir, 'rev-parse', 'feature')).toBe(head);
    expect(git(remote.dir, 'rev-parse', 'feature^{tree}')).toBe(git(local, 'rev-parse', `${ahead}^{tree}`));

    git(local, 'checkout', '-q', '-b', 'other', 'origin/main');
    commit(local, { 'other.txt': 'other\n' });
    await expect(pushCommits(client, { repo: 'acme/app', cwd: local, branch: 'feature' })).rejects.toThrow(
      /not a fast forward/
    );
    await expect(
      pushCommits(client, { repo: 'acme/app', cwd: local, branch: 'feature', replace: remote.feature })
    ).rejects.toThrow('moved since this run started');
    const replaced = await pushCommits(client, { repo: 'acme/app', cwd: local, branch: 'feature', replace: head });
    expect(git(remote.dir, 'rev-parse', 'feature')).toBe(replaced);
    expect(git(remote.dir, 'cat-file', '-p', 'feature:other.txt')).toBe('other');
  });

  it('refuses history that shares no commit with GitHub', async () => {
    const { local, client } = setup();
    const orphan = temp('orphan');
    git(orphan, 'init', '-q', '-b', 'x');
    commit(orphan, { 'x.txt': 'x\n' });
    git(local, 'fetch', '-q', orphan, 'x:refs/elsewhere/x');
    git(local, 'checkout', '-q', '--detach', 'refs/elsewhere/x');
    commit(local, { 'y.txt': 'y\n' });
    await expect(pushCommits(client, { repo: 'acme/app', cwd: local, branch: 'bothub/2' })).rejects.toThrow(
      /has no parent on GitHub/
    );
  });
});
