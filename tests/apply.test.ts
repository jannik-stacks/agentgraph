import { describe, expect, it } from 'vitest';
import { apply, noteFile } from '../src/apply.ts';
import { appJwt, gh, githubApp, type Fetch } from '../src/github-app.ts';
import type { Proposal } from '../src/outputs.ts';
import { localIssues } from '../src/issues-local.ts';
import type { BotEvent } from '../src/types.ts';
import { temp } from './git.ts';

type Call = { method: string; url: string; headers: Record<string, string>; body?: unknown };

const fakeFetch = (respond: (call: Call) => { status?: number; json?: unknown } = () => ({ json: {} })) => {
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init = {}) => {
    const call: Call = {
      method: init.method ?? 'GET',
      url,
      headers: init.headers as Record<string, string>,
      ...(init.body !== undefined && { body: JSON.parse(init.body as string) }),
    };
    calls.push(call);
    const { status = 200, json } = respond(call);
    return new Response(json === undefined ? null : JSON.stringify(json), { status });
  };
  return { calls, fetch };
};

const toPem = (der: ArrayBuffer) =>
  `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(der)))
    .match(/.{1,64}/g)
    ?.join('\n')}\n-----END PRIVATE KEY-----\n`;

const fromBase64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

const keys = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify']
);
const privateKey = toPem(await crypto.subtle.exportKey('pkcs8', keys.privateKey));

describe('appJwt', () => {
  it('signs an RS256 JWT that verifies with the public key', async () => {
    const now = Date.parse('2026-10-12T00:00:00Z');
    const jwt = await appJwt({ appId: 123, privateKey }, now);
    const [header, claims, signature] = jwt.split('.') as [string, string, string];
    const decode = (part: string) => JSON.parse(new TextDecoder().decode(fromBase64url(part)));
    expect(decode(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decode(claims)).toEqual({ iat: now / 1000 - 60, exp: now / 1000 + 540, iss: '123' });
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      keys.publicKey,
      fromBase64url(signature),
      new TextEncoder().encode(`${header}.${claims}`)
    );
    expect(valid).toBe(true);
  });

  it('explains how to convert a PKCS#1 key', async () => {
    const pkcs1 = '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----';
    await expect(appJwt({ appId: 1, privateKey: pkcs1 })).rejects.toThrow(/openssl pkcs8 -topk8 -nocrypt/);
    await expect(appJwt({ appId: 1, privateKey: 'nope' })).rejects.toThrow(/BEGIN PRIVATE KEY/);
  });
});

describe('githubApp', () => {
  it('exchanges a JWT for an installation token and caches it until a minute before expiry', async () => {
    let now = Date.parse('2026-10-12T00:00:00Z');
    const { calls, fetch } = fakeFetch(() => ({
      status: 201,
      json: { token: `ghs_${calls.length}`, expires_at: new Date(now + 3600_000).toISOString() },
    }));
    const app = githubApp({ appId: 1, privateKey }, { fetch, now: () => now });
    expect(await app.installationToken(42)).toBe('ghs_1');
    now += 3500_000;
    expect(await app.installationToken(42)).toBe('ghs_1');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.github.com/app/installations/42/access_tokens',
    });
    expect(calls[0]?.headers.Authorization).toMatch(/^Bearer ey/);
    now += 60_000;
    expect(await app.installationToken(42)).toBe('ghs_2');
  });

  it('gives a long-lived client a fresh token once the cached one expires', async () => {
    let now = Date.parse('2026-10-12T00:00:00Z');
    const { calls, fetch } = fakeFetch(({ url }) =>
      url.endsWith('/access_tokens')
        ? { status: 201, json: { token: `ghs_${calls.length}`, expires_at: new Date(now + 3600_000).toISOString() } }
        : { json: {} }
    );
    const client = githubApp({ appId: 1, privateKey }, { fetch, now: () => now }).client(42);
    await client('GET', '/repos/a/b');
    now += 3600_000;
    await client('GET', '/repos/a/b');
    const auth = calls.filter(c => c.url.endsWith('/repos/a/b')).map(c => c.headers.Authorization);
    expect(auth).toEqual(['Bearer ghs_1', 'Bearer ghs_3']);
  });
});

describe('gh', () => {
  it('sends the GitHub headers and throws with the status on failure', async () => {
    const { calls, fetch } = fakeFetch(() => ({ status: 404, json: { message: 'Not Found' } }));
    const error = await gh('t', fetch)('GET', '/repos/a/b').catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 404, message: expect.stringMatching(/GET \/repos\/a\/b failed with 404/) });
    expect(calls[0]?.headers).toEqual({
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer t',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'bothub',
    });
  });
});

describe('apply', () => {
  const event: BotEvent = {
    id: 'd1',
    ts: '2026-10-12T00:00:00.000Z',
    source: 'github',
    trigger: 'issue_comment',
    repo: 'acme/app',
    number: 7,
    actor: { login: 'morgan', association: 'OWNER' },
  };
  const push = async ({ branch }: { branch: string }) => `https://github.com/acme/app/tree/${branch}`;

  /** GitHub as seen by `apply`: issue #7 with `comments`, open pull requests `pulls`, and `rest` for writes. */
  const github =
    (
      { comments = [], pulls = [] }: { comments?: unknown[]; pulls?: unknown[] } = {},
      rest: (call: Call) => { status?: number; json?: unknown } = ({ url }) => ({
        json: { html_url: `${url}#created` },
      })
    ) =>
    (call: Call): { status?: number; json?: unknown } => {
      const { method, url } = call;
      if (method !== 'GET') return rest(call);
      if (url.endsWith('/issues/7'))
        return { json: { number: 7, title: 'Task', state: 'open', labels: [], html_url: 'i7' } };
      if (url.endsWith('/parent')) return { status: 404, json: { message: 'Not Found' } };
      if (url.includes('/comments?')) return { json: comments };
      if (url.includes('/pulls?')) return { json: pulls };
      if (url.includes('/sub_issues?')) return { json: [] };
      if (url.endsWith('/repos/acme/app')) return { json: { default_branch: 'main' } };
      return { json: {} };
    };
  const pull = (html_url: string) => ({
    number: 1,
    html_url,
    title: 'Fix',
    state: 'open',
    head: { ref: 'bothub/7', sha: 'h', repo: { full_name: 'acme/app' } },
    base: { ref: 'main', sha: 'm' },
  });
  const writes = (calls: Call[]) =>
    calls.filter(c => c.method !== 'GET').map(c => [c.method, c.url.replace('https://api.github.com', ''), c.body]);

  it('pushes first, applies each kind with its key and reports skipped ones', async () => {
    const { calls, fetch } = fakeFetch(
      github({}, ({ method, url }) => ({
        json:
          method === 'POST' && url.endsWith('/issues')
            ? { id: 99, number: 12, title: 'Which database?', state: 'open', labels: ['unsure'], html_url: 'i12' }
            : url.endsWith('/pulls')
              ? pull(`${url}#created`)
              : { html_url: `${url}#created` },
      }))
    );
    const proposals: Proposal[] = [
      { kind: 'reply', body: 'done' },
      { kind: 'label', add: ['bot'], remove: ['needs triage'] },
      { kind: 'merge-request', title: 'Fix', body: 'Closes #7', branch: 'bothub/7', draft: true },
      { kind: 'ask', question: 'Which database?' },
      { kind: 'push', branch: 'bothub/7', files: ['a.ts'] },
      { kind: 'note', note: 'style', slug: 'x', title: 'X', body: 'Do x.' },
    ];
    const journal: string[][] = [];
    const results = await apply(proposals, {
      event,
      gh: gh('t', fetch),
      push,
      record: async results => journal.push(results.map(r => r.status)),
    });
    expect(results.map(r => [r.kind, r.key, r.status])).toEqual([
      ['push', 'd1/push-1', 'applied'],
      ['reply', 'd1/reply-1', 'applied'],
      ['label', 'd1/label-1', 'applied'],
      ['merge-request', 'd1/merge-request-1', 'applied'],
      ['ask', 'd1/ask-1', 'applied'],
      ['note', 'd1/note-1', 'skipped'],
    ]);
    expect(journal[0]).toEqual(Array(6).fill('pending'));
    expect(journal.at(-1)).toEqual(results.map(r => r.status));
    expect(results[0]?.url).toBe('https://github.com/acme/app/tree/bothub/7');
    expect(results[1]?.url).toBe('https://api.github.com/repos/acme/app/issues/7/comments#created');
    expect(writes(calls)).toEqual([
      ['POST', '/repos/acme/app/issues/7/comments', { body: 'done\n\n<!-- bothub:d1/reply-1 -->' }],
      ['POST', '/repos/acme/app/issues/7/labels', { labels: ['bot'] }],
      ['DELETE', '/repos/acme/app/issues/7/labels/needs%20triage', undefined],
      [
        'POST',
        '/repos/acme/app/pulls',
        { title: 'Fix', body: 'Closes #7', head: 'bothub/7', draft: true, base: 'main' },
      ],
      [
        'POST',
        '/repos/acme/app/issues',
        { title: 'Which database?', body: 'Which database?\n\n<!-- bothub:d1/ask-1 -->', labels: ['unsure'] },
      ],
      ['POST', '/repos/acme/app/issues/7/sub_issues', { sub_issue_id: 99 }],
      ['POST', '/repos/acme/app/issues/7/comments', { body: '@morgan needs a human: #12' }],
    ]);
    expect(calls.some(c => c.url.includes('/pulls?') && c.url.includes('head=acme%3Abothub%2F7'))).toBe(true);
  });

  it('finds what an earlier attempt already wrote instead of writing it again', async () => {
    const posted = {
      id: 1,
      body: 'done\n\n<!-- bothub:d1/reply-1 -->',
      html_url: 'c1',
      issue_url: '',
      author_association: 'NONE',
      created_at: event.ts,
    };
    const { calls, fetch } = fakeFetch(github({ comments: [posted], pulls: [pull('pr1')] }));
    const results = await apply(
      [
        { kind: 'reply', body: 'done' },
        { kind: 'merge-request', title: 'Fix', body: '', branch: 'bothub/7' },
      ],
      { event, gh: gh('t', fetch), push }
    );
    expect(results).toEqual([
      { kind: 'reply', key: 'd1/reply-1', status: 'applied', url: 'c1', reason: 'already posted' },
      { kind: 'merge-request', key: 'd1/merge-request-1', status: 'applied', url: 'pr1', reason: 'already open' },
    ]);
    expect(writes(calls)).toEqual([]);
  });

  it('skips effects an earlier run recorded and pushes only when the remote is behind', async () => {
    const { calls, fetch } = fakeFetch(github());
    const seen: { expected?: string }[] = [];
    const pushing = async ({ branch }: { branch: string }, journal: { expected?: string }) => {
      seen.push(journal);
      return `https://github.com/acme/app/tree/${branch}`;
    };
    const results = await apply(
      [
        { kind: 'push', branch: 'bothub/7', files: ['a.ts'] },
        { kind: 'reply', body: 'done' },
      ],
      {
        event,
        gh: gh('t', fetch),
        push: pushing,
        prior: [
          { kind: 'push', key: 'd1/push-1', status: 'pending', sha: 'abc' },
          { kind: 'reply', key: 'd1/reply-1', status: 'applied', url: 'c1' },
        ],
      }
    );
    expect(seen).toEqual([expect.objectContaining({ expected: 'abc' })]);
    expect(results[1]).toEqual({
      kind: 'reply',
      key: 'd1/reply-1',
      status: 'applied',
      url: 'c1',
      reason: 'applied by an earlier run',
    });
    expect(writes(calls)).toEqual([]);
  });

  it('lands a note as a proposed note file in the hub when the hub has a repository', async () => {
    const note: Proposal = {
      kind: 'note',
      note: 'caveat',
      slug: 'fork-prs',
      title: 'Fork PRs?',
      body: 'Which repo?\n',
    };
    expect(noteFile(note as Extract<Proposal, { kind: 'note' }>)).toEqual({
      path: 'notes/caveat/fork-prs.md',
      content: '---\ntitle: Fork PRs?\nstatus: proposed\n---\n\nWhich repo?\n',
    });
    const opened: unknown[] = [];
    const hubPr = async (pr: unknown) => (opened.push(pr), 'https://github.com/acme/hub/pull/1');
    const { fetch } = fakeFetch();
    expect(await apply([note], { event, gh: gh('t', fetch), push, hubPr })).toEqual([
      { kind: 'note', key: 'd1/note-1', status: 'applied', url: 'https://github.com/acme/hub/pull/1' },
    ]);
    expect(opened).toEqual([
      {
        files: [noteFile(note as Extract<Proposal, { kind: 'note' }>)],
        title: 'note: Fork PRs?',
        body: `Proposed caveat note from ${event.url ?? event.repo}.`,
      },
    ]);
    expect(await apply([note], { event, gh: gh('t', fetch), push })).toEqual([
      { kind: 'note', key: 'd1/note-1', status: 'skipped', reason: 'the hub has no repository to land it in' },
    ]);
  });

  it('lands a hub change with deletions, and refuses one that reaches hub.yaml, bots or workflows', async () => {
    const opened: unknown[] = [];
    const hubPr = async (change: unknown) => (opened.push(change), 'bothub/hub/skills-1');
    const { fetch } = fakeFetch();
    const change: Proposal = {
      kind: 'hub',
      title: 'Sharper review skill',
      body: 'why',
      files: [
        { path: 'skills/review.md', content: 'x' },
        { path: 'notes/style/old.md', delete: true },
      ],
    };
    expect(await apply([change], { event, gh: gh('t', fetch), push, hubPr })).toEqual([
      { kind: 'hub', key: 'd1/hub-1', status: 'applied', url: 'bothub/hub/skills-1' },
    ]);
    expect(opened).toEqual([
      {
        title: 'Sharper review skill',
        body: 'why',
        files: [
          { path: 'skills/review.md', content: 'x' },
          { path: 'notes/style/old.md', content: null },
        ],
      },
    ]);
    const refused = await apply(
      [
        {
          ...change,
          files: [
            { path: 'notes/a.md', content: 'x' },
            { path: 'bots/b.md', content: 'x' },
          ],
        },
      ],
      { event, gh: gh('t', fetch), push, hubPr }
    );
    expect(refused).toEqual([
      { kind: 'hub', key: 'd1/hub-1', status: 'failed', reason: 'path "bots/b.md" changes only by a human' },
    ]);
    expect(opened).toHaveLength(1);
  });

  it('keeps going after a failure', async () => {
    const { fetch } = fakeFetch(
      github({}, ({ url }) =>
        url.endsWith('/pulls') ? { status: 422, json: { message: 'No commits' } } : { json: { html_url: 'u' } }
      )
    );
    const results = await apply(
      [
        { kind: 'merge-request', title: 't', body: '', branch: 'bothub/x', into: 'dev' },
        { kind: 'reply', body: 'still here' },
      ],
      { event, gh: gh('t', fetch), push }
    );
    expect(results[0]).toMatchObject({ kind: 'merge-request', status: 'failed', reason: expect.stringMatching(/422/) });
    expect(results[1]).toEqual({ kind: 'reply', key: 'd1/reply-1', status: 'applied', url: 'u' });
  });

  it('skips a pull request whose head failed to push', async () => {
    const { calls, fetch } = fakeFetch();
    const refuse = async () => {
      throw new Error('"x.ts" changed but is not listed in the proposal');
    };
    const results = await apply(
      [
        { kind: 'merge-request', title: 't', body: '', branch: 'bothub/x', into: 'main' },
        { kind: 'push', branch: 'bothub/x', files: [] },
      ],
      { event, gh: gh('t', fetch), push: refuse }
    );
    expect(results).toEqual([
      {
        kind: 'push',
        key: 'd1/push-1',
        status: 'failed',
        reason: '"x.ts" changed but is not listed in the proposal',
      },
      { kind: 'merge-request', key: 'd1/merge-request-1', status: 'skipped', reason: 'pushing bothub/x failed' },
    ]);
    expect(calls).toEqual([]);
  });

  it('fails comments without an issue number and ignores removing an absent label', async () => {
    const { fetch } = fakeFetch(github({}, ({ method }) => (method === 'DELETE' ? { status: 404 } : { json: {} })));
    const { number: _, ...noNumber } = event;
    expect(await apply([{ kind: 'reply', body: 'x' }], { event: noNumber, gh: gh('t', fetch), push })).toEqual([
      {
        kind: 'reply',
        key: 'd1/reply-1',
        status: 'failed',
        reason: 'the event has no issue or pull request to write to',
      },
    ]);
    expect(await apply([{ kind: 'label', remove: ['gone'] }], { event, gh: gh('t', fetch), push })).toEqual([
      { kind: 'label', key: 'd1/label-1', status: 'applied' },
    ]);
  });

  it('asks a question once per issue, adding a later run of it to the open question as a comment', async () => {
    const issues = localIssues(temp('issues'), { repo: 'acme/app', as: 'morgan' });
    await issues.create({ title: 'Task' });
    const local = { ...event, number: 1, source: 'local' as const };
    const ask = [{ kind: 'ask' as const, question: 'Which database?\nPostgres or SQLite.' }];

    const first = await apply(ask, { event: local, issues, push });
    const second = await apply(ask, { event: { ...local, id: 'd2' }, issues, push });
    const replayed = await apply(ask, { event: { ...local, id: 'd2' }, issues, push });

    expect([first, second, replayed].map(([r]) => [r?.status, r?.reason])).toEqual([
      ['applied', undefined],
      ['applied', undefined],
      ['applied', 'already asked'],
    ]);
    const questions = await issues.list({ label: 'unsure', parent: 1 });
    expect(questions.map(q => q.title)).toEqual(['Which database?']);
    const question = await issues.get(questions[0]!.number);
    expect(question?.comments.map(c => c.body)).toEqual([
      'Which database?\nPostgres or SQLite.\n\n<!-- bothub:d2/ask-1 -->',
    ]);
    expect((await issues.get(1))?.comments.map(c => c.body)).toEqual(['@morgan needs a human: #2']);

    expect(await apply(ask, { event: local, push })).toMatchObject([
      { status: 'failed', reason: 'no issue tracker to write to' },
    ]);
  });
});
