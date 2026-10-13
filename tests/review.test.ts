import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { api } from '../src/api.ts';
import { localIssues } from '../src/issues-local.ts';
import { Missing } from '../src/pulls.ts';
import { Invalid, comment, operator } from '../src/review.ts';
import { openStore } from '../src/store.ts';
import { temp, write } from './kit.ts';

const setup = () => {
  const dir = temp('review-hub');
  write(dir, {
    'hub.yaml': 'issues: local\n',
    'skills/work.md': '---\ndescription: Work.\n---\nWork.\n',
    'bots/bot.md': '---\nharness: opencode\ntools: [read]\nreturns: [reply]\n---\nYou work.\n',
    'workflows/issue.md':
      '---\nname: issue\non:\n  issue_comment:\n    types: [created]\n    command: /bothub\njobs:\n  work: { type: bot, bot: bot, skill: work }\n---\nWorks.\n',
    'issues/7-task.md': '---\ntitle: Task\nauthor: morgan\n---\n\nDo it.\n',
  });
  const data = temp('review-data');
  const opened = {
    number: 1,
    op: 'open',
    title: 't',
    body: '',
    branch: 'bothub/7',
    into: 'main',
    sha: 'a',
    job: 'issue/work',
    event: 'e',
  };
  writeFileSync(join(data, 'pulls.jsonl'), `${JSON.stringify(opened)}\n`);
  const ops = () =>
    readFileSync(join(data, 'pulls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .slice(1)
      .map(line => JSON.parse(line) as Record<string, unknown>);
  return { dir, data, ops, hub: { dir, data } };
};

describe('comment', () => {
  it('writes line comments then one command on a merge request, as the local operator', async () => {
    const { hub, ops } = setup();
    const lines = [{ path: 'src/a.ts', line: 3, body: 'this test loops, use it.each' }];
    expect(await comment(hub, { pull: 1, body: ' see the line ', lines, continue: 'fresh' })).toEqual({
      text: '/bothub fresh see the line',
    });
    expect(ops()).toEqual([
      expect.objectContaining({ op: 'comment', author: operator(), path: 'src/a.ts', side: 'new', line: 3 }),
      expect.objectContaining({ op: 'comment', author: operator(), body: '/bothub fresh see the line' }),
    ]);
    await comment(hub, { pull: 1, body: 'just saying', continue: 'none' });
    await comment(hub, { pull: 1 });
    expect(
      ops()
        .slice(2)
        .map(op => op.body)
    ).toEqual(['just saying', '/bothub']);
  });

  it('comments on a local issue, to answer a bot', async () => {
    const { hub, dir } = setup();
    await comment(hub, { issue: 7, body: 'Use port 8080.', continue: 'changed' });
    const issue = await localIssues(join(dir, 'issues'), { repo: 'r' }).get(7);
    expect(issue?.comments).toMatchObject([{ author: operator(), body: '/bothub Use port 8080.' }]);
  });

  it('refuses bad input and names what is missing', async () => {
    const { hub } = setup();
    await expect(comment(hub, { pull: 1, issue: 7 })).rejects.toThrow(Invalid);
    await expect(comment(hub, { issue: 7, lines: [{ path: 'a', line: 1, body: 'x' }] })).rejects.toThrow(Invalid);
    await expect(comment(hub, { pull: 1, body: ' ', continue: 'none' })).rejects.toThrow('write a comment');
    await expect(comment(hub, { pull: 1, author: 'mallory' })).rejects.toThrow(Invalid);
    await expect(comment(hub, { pull: 2 })).rejects.toThrow(Missing);
    await expect(comment(hub, { issue: 9 })).rejects.toThrow(Missing);
  });
});

describe('POST /api/comments', () => {
  const post = (handler: ReturnType<typeof api>, body: unknown, headers: Record<string, string> = {}) =>
    handler(
      new Request('http://127.0.0.1/api/comments', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      })
    );

  it('passes the body to `comment` and maps its errors', async () => {
    const { dir, data, ops } = setup();
    const handler = api({ hubDir: dir, store: openStore(data) });
    const ok = await post(handler, { pull: 1, body: 'hi', continue: 'all' });
    expect([ok.status, await ok.json()]).toEqual([201, { text: '/bothub all hi' }]);
    expect(ops()).toHaveLength(1);
    expect((await post(handler, { pull: 1, continue: 'sometimes' })).status).toBe(400);
    expect((await post(handler, { pull: 5 })).status).toBe(404);
  });

  it('refuses a text/plain body and another origin, so a web page cannot start runs', async () => {
    const { dir, data, ops } = setup();
    const handler = api({ hubDir: dir, store: openStore(data) });
    expect((await post(handler, { pull: 1 }, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post(handler, { pull: 1 }, { origin: 'https://evil.example' })).status).toBe(403);
    expect(ops()).toEqual([]);
  });
});
