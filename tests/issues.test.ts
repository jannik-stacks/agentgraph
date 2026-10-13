import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/config.ts';
import { plan } from '../src/dispatch.ts';
import type { GitHub, GitHubError } from '../src/github-app.ts';
import { githubIssues } from '../src/issues-github.ts';
import { localIssues, parseIssue, renderIssue } from '../src/issues-local.ts';
import type { BotEvent } from '../src/types.ts';
import { temp } from './git.ts';

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(done => setTimeout(done, 5));
};

describe('localIssues', () => {
  it('creates numbered files, filters, labels, links and closes', async () => {
    const dir = temp('issues');
    const issues = localIssues(dir, { repo: 'acme/app' });
    const plan = await issues.create({ title: 'Ship JSON', labels: ['plan'], links: [3] });
    const step = await issues.create({ title: 'Step one: encode!', body: 'Encode it.' });
    expect([plan.number, step.number]).toEqual([1, 2]);
    expect(readdirSync(dir).sort()).toEqual(['1-ship-json.md', '2-step-one-encode.md']);

    await issues.link(1, 2);
    await issues.label(2, { add: ['ready', 'x'], remove: ['x'] });
    await issues.comment(2, 'On it.');
    expect(await issues.list({ parent: 1 })).toMatchObject([{ number: 2, labels: ['ready'], comments: [] }]);
    expect(await issues.list({ label: 'plan' })).toMatchObject([{ number: 1, links: [3] }]);

    await issues.close(1);
    expect((await issues.list()).map(i => i.number)).toEqual([2]);
    expect((await issues.list({ state: 'closed' })).map(i => i.number)).toEqual([1]);
    expect(await issues.get(2)).toMatchObject({
      title: 'Step one: encode!',
      parent: 1,
      author: 'bothub[bot]',
      body: 'Encode it.',
      comments: [{ author: 'bothub[bot]', body: 'On it.', url: 'issues/2-step-one-encode.md#comment-1' }],
    });
    expect(await issues.get(9)).toBeUndefined();
    await expect(issues.link(9, 2)).rejects.toThrow('no issue #9');
  });

  it('never gives two writers on one directory the same number', async () => {
    const dir = temp('issues');
    writeFileSync(join(dir, '.2.lock'), '');
    const writers = [localIssues(dir, { repo: 'a/b' }), localIssues(dir, { repo: 'a/b', as: 'morgan' })];
    const created = await Promise.all(
      Array.from({ length: 10 }, (_, i) => writers[i % 2]!.create({ title: `Issue ${i}` }))
    );
    const numbers = created.map(i => i.number).sort((x, y) => x - y);
    expect(new Set(numbers).size).toBe(10);
    expect(numbers).not.toContain(2);
    expect(readdirSync(dir).filter(name => name.endsWith('.lock'))).toEqual(['.2.lock']);
    expect(readdirSync(dir).filter(name => name.endsWith('.md'))).toHaveLength(10);
  });

  it('writes files that read back the same, with comments as headed sections', () => {
    const source = [
      '---',
      'title: A spec',
      'state: open',
      'labels: [spec]',
      'parent: 5',
      '---',
      '',
      'Body text.',
      '',
      '## Not a comment',
      '',
      'Still body.',
      '',
      '## @morgan at 2026-10-12T10:00:00.000Z',
      '',
      'First.',
      '',
      '## @bothub[bot] at 2026-10-12T10:05:00.000Z',
      '',
      'Second.',
      '',
    ].join('\n');
    const issue = parseIssue('4-a-spec.md', source);
    expect(issue).toMatchObject({
      number: 4,
      labels: ['spec'],
      parent: 5,
      body: 'Body text.\n\n## Not a comment\n\nStill body.',
      comments: [
        { author: 'morgan', ts: '2026-10-12T10:00:00.000Z', body: 'First.' },
        { author: 'bothub[bot]', ts: '2026-10-12T10:05:00.000Z', body: 'Second.' },
      ],
    });
    expect(renderIssue(issue)).toBe(source);
    expect(() => parseIssue('spec.md', source)).toThrow('<number>-<slug>.md');
    expect(() => parseIssue('1-x.md', '---\nstate: open\n---\n')).toThrow('1-x.md');
  });

  it('watches the directory and emits webhook-shaped events', async () => {
    const dir = temp('issues');
    writeFileSync(join(dir, '1-task.md'), '---\ntitle: Task\n---\n\nDo it.\n');
    const events: BotEvent[] = [];
    const { ready, stop } = localIssues(dir, { repo: 'acme/app' }).watch(e => events.push(e), { interval: 5 });
    await ready;
    await localIssues(dir, { repo: 'acme/app', as: 'morgan' }).comment(1, '/bothub go');
    await localIssues(dir, { repo: 'acme/app' }).comment(1, '/bothub loop');
    await localIssues(dir, { repo: 'acme/app' }).create({ title: 'New' });
    await until(() => events.length >= 3);
    stop();
    expect(events.map(e => [e.trigger, e.action, e.number, e.actor, e.body, e.source])).toEqual([
      ['issue_comment', 'created', 1, { login: 'morgan', association: 'OWNER' }, '/bothub go', 'local'],
      ['issue_comment', 'created', 1, { login: 'bothub[bot]', association: 'NONE' }, '/bothub loop', 'local'],
      ['issues', 'opened', 2, { login: 'bothub[bot]', association: 'NONE' }, '', 'local'],
    ]);

    const result = compile([
      {
        path: 'workflows/w.md',
        source: '---\non: { issue_comment: { command: /bothub } }\njobs:\n  a: { type: script, run: echo }\n---\n',
      },
    ]);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(events.slice(0, 2).map(e => plan(e, result.config).length)).toEqual([1, 0]);

    expect(events.map(e => e.id)).toEqual([
      expect.stringMatching(/^local-1-comment-1-[0-9a-f]{12}$/),
      expect.stringMatching(/^local-1-comment-2-[0-9a-f]{12}$/),
      'local-2-opened',
    ]);
    const again: BotEvent[] = [];
    const watcher = localIssues(dir, { repo: 'acme/app' }).watch(e => again.push(e), { interval: 5 });
    await watcher.ready;
    await localIssues(dir, { repo: 'acme/app' }).label(2, { add: ['ready'] });
    await until(() => again.length >= 1);
    watcher.stop();
    expect(again[0]?.id).toMatch(/^local-2-labeled-[0-9a-f]{12}$/);
    expect(new Set([...events, ...again].map(e => e.id)).size).toBe(4);
  });

  it('notices a hand edit through file system events, closing and reopening an issue', async () => {
    const dir = temp('issues');
    const file = join(dir, '1-task.md');
    writeFileSync(file, '---\ntitle: Task\nauthor: morgan\n---\n\nDo it.\n');
    const events: BotEvent[] = [];
    const { ready, stop } = localIssues(dir, { repo: 'acme/app' }).watch(e => events.push(e));
    await ready;
    await new Promise(done => setTimeout(done, 20));
    writeFileSync(file, '---\ntitle: Task\nstate: closed\nauthor: morgan\n---\n\nDo it.\n');
    await until(() => events.length >= 1);
    writeFileSync(file, '---\ntitle: Task\nstate: open\nauthor: morgan\n---\n\nDo it.\n');
    await until(() => events.length >= 2);
    stop();
    expect(events.map(e => [e.trigger, e.action, e.number, e.actor.login])).toEqual([
      ['issues', 'closed', 1, 'morgan'],
      ['issues', 'reopened', 1, 'morgan'],
    ]);
    expect(events[0]?.id).toMatch(/^local-1-closed-[0-9a-f]{12}$/);

    const early = localIssues(temp('issues'), { repo: 'acme/app' }).watch(() => {});
    early.stop();
    await early.ready;
  });

  it('attributes labels and closes made through bothub to the writer, so a bot label passes no trust guard', async () => {
    const dir = temp('issues');
    writeFileSync(join(dir, '1-task.md'), '---\ntitle: Task\nauthor: morgan\n---\n\nDo it.\n');
    const events: BotEvent[] = [];
    const { ready, stop } = localIssues(dir, { repo: 'acme/app' }).watch(e => events.push(e), { interval: 5 });
    await ready;
    const bot = localIssues(dir, { repo: 'acme/app' });
    await bot.label(1, { add: ['needs-input'] });
    await until(() => events.length >= 1);
    await localIssues(dir, { repo: 'acme/app', as: 'morgan' }).label(1, { add: ['go'] });
    await until(() => events.length >= 2);
    await bot.close(1);
    await until(() => events.length >= 3);
    writeFileSync(
      join(dir, '1-task.md'),
      readFileSync(join(dir, '1-task.md'), 'utf8').replace('labels: [', 'labels: [hand, ')
    );
    await until(() => events.length >= 4);
    stop();
    expect(events.map(e => [e.action, e.label, e.actor])).toEqual([
      ['labeled', 'needs-input', { login: 'bothub[bot]', association: 'NONE' }],
      ['labeled', 'go', { login: 'morgan', association: 'OWNER' }],
      ['closed', undefined, { login: 'bothub[bot]', association: 'NONE' }],
      ['labeled', 'hand', { login: 'morgan', association: 'OWNER' }],
    ]);
    expect((await bot.get(1))?.changes).toEqual([
      { by: 'bothub[bot]', action: 'labeled', label: 'needs-input' },
      { by: 'morgan', action: 'labeled', label: 'go' },
      { by: 'bothub[bot]', action: 'closed' },
    ]);

    const result = compile([
      {
        path: 'workflows/w.md',
        source:
          '---\non: { issues: { types: [labeled], guard: { associations: [OWNER] } } }\njobs:\n  a: { type: script, run: echo }\n---\n',
      },
    ]);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(events.map(e => plan(e, result.config).length)).toEqual([0, 1, 0, 1]);
  });

  it('reports the file of an issue it cannot read', async () => {
    const dir = temp('issues');
    writeFileSync(join(dir, '1-bad.md'), '---\ntitle: Bad\nstate: maybe\n---\n');
    await expect(localIssues(dir, { repo: 'a/b' }).list()).rejects.toThrow('1-bad.md');
    expect(readFileSync(join(dir, '1-bad.md'), 'utf8')).toContain('maybe');
  });
});

describe('githubIssues', () => {
  const rest = (number: number, extra: object = {}) => ({
    id: number * 100,
    number,
    title: `Issue ${number}`,
    state: 'open',
    body: `See #${number + 1} and #9.`,
    html_url: `https://github.com/a/b/issues/${number}`,
    user: { login: 'morgan' },
    author_association: 'OWNER',
    labels: [{ name: 'spec' }],
    created_at: '2026-10-12T00:00:00Z',
    ...extra,
  });
  const fake = (routes: Record<string, unknown>) => {
    const calls: string[] = [];
    const gh = (async (method: string, path: string, body?: unknown) => {
      const key = `${method} ${path}`;
      calls.push(body === undefined ? key : `${key} ${JSON.stringify(body)}`);
      if (key in routes) return routes[key];
      throw Object.assign(new Error(`${key} failed with 404`), { status: 404 }) satisfies GitHubError;
    }) as GitHub;
    return { gh, calls };
  };

  it('reads issues with comments, parents from the sub-issues API and links from #references', async () => {
    const { gh } = fake({
      'GET /repos/a/b/issues/4': rest(4),
      'GET /repos/a/b/issues/4/comments?per_page=100': [
        {
          id: 1,
          body: 'Hi',
          html_url: 'c1',
          issue_url: 'x/issues/4',
          user: null,
          author_association: 'NONE',
          created_at: 't',
        },
      ],
      'GET /repos/a/b/issues/4/parent': rest(9),
      'GET /repos/a/b/issues?state=open&per_page=100&labels=spec': [rest(4), rest(6, { pull_request: {} })],
      'GET /repos/a/b/issues/9/sub_issues?per_page=100': [rest(4), rest(5, { state: 'closed' })],
    });
    const issues = githubIssues(gh, 'a/b');
    expect(await issues.get(4)).toMatchObject({
      number: 4,
      labels: ['spec'],
      parent: 9,
      links: [5],
      comments: [{ author: 'ghost', body: 'Hi', url: 'c1' }],
    });
    expect(await issues.get(7)).toBeUndefined();
    expect((await issues.list({ label: 'spec' })).map(i => i.number)).toEqual([4]);
    expect((await issues.list({ parent: 9 })).map(i => [i.number, i.parent])).toEqual([[4, 9]]);
  });

  it('creates sub-issues, comments, labels, closes and links over REST', async () => {
    const { gh, calls } = fake({
      'POST /repos/a/b/issues': rest(12, { labels: ['unsure'] }),
      'POST /repos/a/b/issues/7/sub_issues': {},
      'POST /repos/a/b/issues/7/comments': {
        id: 3,
        body: 'ok',
        html_url: 'c3',
        issue_url: 'x',
        user: { login: 'bot' },
        author_association: 'NONE',
        created_at: 't',
      },
      'POST /repos/a/b/issues/7/labels': [],
      'PATCH /repos/a/b/issues/7': {},
      'GET /repos/a/b/issues/12': rest(12),
    });
    const issues = githubIssues(gh, 'a/b');
    expect(await issues.create({ title: 'Q?', body: 'Why?', labels: ['unsure'], parent: 7, links: [4] })).toMatchObject(
      {
        number: 12,
        parent: 7,
      }
    );
    expect(await issues.comment(7, 'ok')).toEqual({ author: 'bot', ts: 't', body: 'ok', url: 'c3' });
    await issues.label(7, { add: ['ready'], remove: ['gone'] });
    await issues.close(7);
    await issues.link(7, 12);
    expect(calls).toEqual([
      'POST /repos/a/b/issues {"title":"Q?","body":"Why?\\n\\nRelated: #4","labels":["unsure"]}',
      'POST /repos/a/b/issues/7/sub_issues {"sub_issue_id":1200}',
      'POST /repos/a/b/issues/7/comments {"body":"ok"}',
      'POST /repos/a/b/issues/7/labels {"labels":["ready"]}',
      'DELETE /repos/a/b/issues/7/labels/gone',
      'PATCH /repos/a/b/issues/7 {"state":"closed"}',
      'GET /repos/a/b/issues/12',
      'POST /repos/a/b/issues/7/sub_issues {"sub_issue_id":1200}',
    ]);
  });

  it('polls for new issues and comments and emits them once', async () => {
    const later = '2999-01-01T00:00:00Z';
    const gh = (async (_: string, path: string) => {
      if (path.includes('/issues/comments?'))
        return [
          {
            id: 5,
            body: '/bothub go',
            html_url: 'https://github.com/a/b/issues/3#issuecomment-5',
            issue_url: 'https://api.github.com/repos/a/b/issues/3',
            user: { login: 'morgan' },
            author_association: 'MEMBER',
            created_at: later,
          },
        ];
      return [rest(3, { created_at: later }), rest(4, { pull_request: {}, created_at: later })];
    }) as GitHub;
    const events: BotEvent[] = [];
    const { stop } = githubIssues(gh, 'a/b').watch(e => events.push(e), { interval: 5 });
    await until(() => events.length >= 2);
    await new Promise(done => setTimeout(done, 30));
    stop();
    expect(events.map(e => [e.trigger, e.action, e.number, e.actor.association, e.url])).toEqual([
      ['issues', 'opened', 3, 'OWNER', 'https://github.com/a/b/issues/3'],
      ['issue_comment', 'created', 3, 'MEMBER', 'https://github.com/a/b/issues/3#issuecomment-5'],
    ]);
  });
});
