import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GitHub } from '../src/github-app.ts';
import { githubPulls, localPulls } from '../src/pulls.ts';
import { commit, git, sourceRepo, temp } from './git.ts';

/** A bare origin cloned from a source repository, and a way to push new commits on a branch to it. */
const setup = () => {
  const source = sourceRepo();
  const origin = join(temp('bare'), 'app.git');
  git(source.dir, 'clone', '-q', '--bare', source.dir, origin);
  const file = join(temp('pulls'), 'pulls.jsonl');
  const pulls = localPulls({ origin, file, repo: 'acme/app' });
  const push = (branch: string, files: Record<string, string>, from = 'main') => {
    git(source.dir, 'checkout', '-q', '-B', branch, from);
    const sha = commit(source.dir, files);
    git(source.dir, 'push', '-q', '-f', origin, `${branch}:${branch}`);
    git(source.dir, 'checkout', '-q', 'main');
    return sha;
  };
  return { origin, file, pulls, push };
};

describe('localPulls', () => {
  it('opens requests, creating the branch they go into from the default branch', async () => {
    const { origin, file, pulls, push } = setup();
    expect(await pulls.defaultBranch()).toBe('main');
    const head = push('bothub/5-6', { 'a.ts': 'a\n' });
    await expect(pulls.open({ title: 't', body: 'b', branch: 'nope', into: 'bothub/5' })).rejects.toThrow(
      'branch "nope" does not exist'
    );
    const opened = await pulls.open({
      title: 't',
      body: 'b',
      branch: 'bothub/5-6',
      into: 'bothub/5',
      origin: { job: 'plan/implement', event: 'e1' },
    });
    expect(opened).toMatchObject({ number: 1, url: `${origin}#pull/1`, state: 'open', head });
    expect(git(origin, 'rev-parse', 'bothub/5')).toBe(git(origin, 'rev-parse', 'main'));
    expect(git(origin, 'rev-parse', 'refs/pull/1/head')).toBe(head);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      number: 1,
      op: 'open',
      branch: 'bothub/5-6',
      into: 'bothub/5',
      job: 'plan/implement',
      event: 'e1',
      sha: head,
    });
    expect(await pulls.list({ into: 'bothub/5' })).toMatchObject([
      { number: 1, origin: { job: 'plan/implement', event: 'e1' } },
    ]);
    expect(await pulls.list({ into: 'main' })).toEqual([]);
    expect(await pulls.get(1)).toMatchObject({ number: 1, mergeable: true });
    expect(await pulls.get(9)).toBeUndefined();
  });

  it('merges only while both tips are where the merge was checked, then reports it closed', async () => {
    const { origin, pulls, push } = setup();
    const head = push('bothub/5-6', { 'a.ts': 'a\n' });
    await pulls.open({ title: 'Step', body: '', branch: 'bothub/5-6', into: 'bothub/5' });
    const into = git(origin, 'rev-parse', 'bothub/5');
    await expect(pulls.merge(1, { head, into: head })).rejects.toThrow('"bothub/5" moved since the merge was checked');
    await expect(pulls.merge(1, { head: into, into })).rejects.toThrow(
      '"bothub/5-6" moved since the merge was checked'
    );
    const { sha } = await pulls.merge(1, { head, into });
    expect(git(origin, 'rev-parse', 'bothub/5')).toBe(sha);
    expect(git(origin, 'rev-parse', `${sha}^1`, `${sha}^2`).split('\n')).toEqual([into, head]);
    expect(git(origin, 'log', '-1', '--format=%an', sha)).toBe('bothub[bot]');
    await expect(pulls.merge(1, { head, into: sha })).rejects.toThrow('merge request #1 is merged');
    await expect(pulls.merge(2, { head, into })).rejects.toThrow('no merge request #2');
    expect(await pulls.list({ state: 'all' })).toMatchObject([{ number: 1, state: 'merged' }]);
    expect(await pulls.get(1)).not.toHaveProperty('mergeable');
  });

  it('reports a conflicting request as not mergeable and refuses to merge it', async () => {
    const { origin, pulls, push } = setup();
    push('bothub/5', { 'a.ts': 'one\n' });
    const head = push('bothub/5-7', { 'a.ts': 'two\n' });
    await pulls.open({ title: 'Step', body: '', branch: 'bothub/5-7', into: 'bothub/5' });
    expect(await pulls.get(1)).toMatchObject({ mergeable: false });
    const into = git(origin, 'rev-parse', 'bothub/5');
    await expect(pulls.merge(1, { head, into })).rejects.toThrow('merge request #1 conflicts: a.ts');
  });

  it('turns the log into pull_request events with ids that stay the same', async () => {
    const { pulls, push, origin } = setup();
    push('bothub/5-6', { 'a.ts': 'a\n' });
    await pulls.open({ title: 'Step', body: 'Closes #6', branch: 'bothub/5-6', into: 'bothub/5' });
    const moved = push('bothub/5-6', { 'b.ts': 'b\n' }, 'bothub/5-6');
    const first = await pulls.events();
    expect(first.map(e => e.id)).toEqual(['local-pull-1-opened', `local-pull-1-synchronize-${moved.slice(0, 12)}`]);
    expect(first[0]).toMatchObject({
      source: 'local',
      trigger: 'pull_request',
      action: 'opened',
      number: 1,
      branch: 'bothub/5',
      actor: { login: 'bothub[bot]', association: 'NONE' },
    });
    expect(git(origin, 'rev-parse', 'refs/pull/1/head')).toBe(moved);
    expect((await pulls.events()).map(e => e.id)).toEqual(first.map(e => e.id));
    await pulls.merge(1, { head: moved, into: git(origin, 'rev-parse', 'bothub/5') });
    expect((await pulls.events()).map(e => e.action)).toEqual(['opened', 'synchronize', 'closed']);
  });
});

describe('githubPulls', () => {
  const rest = (number: number, extra: Record<string, unknown> = {}) => ({
    number,
    html_url: `https://github.com/acme/app/pull/${number}`,
    title: 't',
    body: 'b\n\n<!-- bothub:request plan/implement e1 -->',
    state: 'open',
    head: { ref: 'bothub/5-6', sha: 'h', repo: { full_name: 'acme/app' } },
    base: { ref: 'bothub/5', sha: 'm' },
    ...extra,
  });

  const fake = (refs: Record<string, string>) => {
    const calls: [string, string, unknown][] = [];
    const gh = (async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      if (path === '/repos/acme/app') return { default_branch: 'main' };
      const ref = /\/git\/ref\/heads\/(.+)$/.exec(path)?.[1];
      if (ref !== undefined) {
        if (refs[ref]) return { object: { sha: refs[ref] } };
        throw Object.assign(new Error('Not Found'), { status: 404 });
      }
      if (method === 'GET' && path.includes('/pulls?'))
        return [rest(1), rest(2, { head: { ref: 'fix', sha: 'f', repo: { full_name: 'someone/app' } } })];
      if (method === 'GET' && path.endsWith('/pulls/1')) return rest(1, { mergeable: true });
      if (method === 'GET' && path.endsWith('/pulls/9')) throw Object.assign(new Error('Not Found'), { status: 404 });
      if (method === 'POST' && path.endsWith('/pulls')) return rest(3);
      return { sha: 'merged' };
    }) as GitHub;
    return { calls, pulls: githubPulls(gh, 'acme/app') };
  };

  it('reads requests, naming branches from forks and the job that opened them', async () => {
    const { pulls, calls } = fake({});
    expect(await pulls.list({ into: 'bothub/5' })).toMatchObject([
      { number: 1, branch: 'bothub/5-6', into: 'bothub/5', origin: { job: 'plan/implement', event: 'e1' } },
      { number: 2, branch: 'someone/app:fix' },
    ]);
    expect(calls[0]?.[1]).toBe('/repos/acme/app/pulls?state=open&per_page=100&base=bothub%2F5');
    expect(await pulls.get(1)).toMatchObject({ number: 1, mergeable: true, head: 'h' });
    expect(await pulls.get(9)).toBeUndefined();
  });

  it('creates the branch a request goes into and marks the job that opened it', async () => {
    const { pulls, calls } = fake({ main: 'm0' });
    await pulls.open({
      title: 't',
      body: 'b',
      branch: 'bothub/5-6',
      into: 'bothub/5',
      origin: { job: 'j', event: 'e' },
    });
    expect(calls.filter(([method]) => method === 'POST')).toEqual([
      ['POST', '/repos/acme/app/git/refs', { ref: 'refs/heads/bothub/5', sha: 'm0' }],
      [
        'POST',
        '/repos/acme/app/pulls',
        { title: 't', body: 'b\n\n<!-- bothub:request j e -->', head: 'bothub/5-6', base: 'bothub/5' },
      ],
    ]);
    await expect(fake({}).pulls.open({ title: 't', body: '', branch: 'x', into: 'y' })).rejects.toThrow(
      'the default branch has no commit to start from'
    );
  });

  it('merges at the checked head, and only while the base has not moved', async () => {
    const { pulls, calls } = fake({});
    expect(await pulls.merge(1, { head: 'h', into: 'm' })).toEqual({ sha: 'merged' });
    expect(calls.at(-1)).toEqual(['PUT', '/repos/acme/app/pulls/1/merge', { sha: 'h', merge_method: 'merge' }]);
    await expect(pulls.merge(1, { head: 'h', into: 'other' })).rejects.toThrow('"bothub/5" moved');
    await expect(pulls.merge(9, { head: 'h', into: 'm' })).rejects.toThrow('no pull request #9');
  });
});
