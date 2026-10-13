import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localIssues } from '../src/issues-local.ts';
import { localOrigin, localPulls, serveHub } from '../src/serve.ts';
import { unsandboxed } from '../src/runner.ts';
import { openStore } from '../src/store.ts';
import type { JobResult } from '../src/pipeline.ts';
import type { BotEvent } from '../src/types.ts';
import { git, sourceRepo, temp } from './git.ts';

const bareOrigin = () => {
  const { dir } = sourceRepo();
  const bare = join(temp('bare'), 'app.git');
  git(dir, 'clone', '-q', '--bare', dir, bare);
  return bare;
};

const files: Record<string, string> = {
  'hub.yaml': 'issues: local\n',
  'bots/helper.md':
    '---\nharness: opencode\nmodel: fast\ntools: [read]\nmax-turns: 5\nreturns: [reply]\nskills: [answer]\n---\nYou help.\n',
  'skills/answer.md': '---\ndescription: Answer the issue.\n---\nAnswer it.\n',
  'workflows/issue.md': [
    '---',
    'name: issue',
    'on:',
    '  issue_comment:',
    '    types: [created]',
    '    command: /bothub',
    '    guard: { associations: [OWNER] }',
    'jobs:',
    '  answer:',
    '    type: bot',
    '    bot: helper',
    '    skill: answer',
    '    returns: [reply]',
    '    mode: warn',
    '---',
    'Answers.',
    '',
  ].join('\n'),
  'issues/1-question.md': '---\ntitle: A question\nstate: open\nlabels: []\nauthor: morgan\n---\n\nWhy?\n',
};

const reply = JSON.stringify({ type: 'end', ok: true, result: '```bothub\n[{"kind":"reply","body":"Because."}]\n```' });
const adapter = {
  command: () => ({ cmd: process.execPath, args: ['-e', `console.log(${JSON.stringify(reply)})`], env: {} }),
  parseLine: (line: string) => (line.trim() ? [JSON.parse(line)] : []),
};

describe('localOrigin', () => {
  it('accepts a local bare repository and refuses anything else', async () => {
    const bare = bareOrigin();
    expect(await localOrigin(bare)).toBe(bare);
    await expect(localOrigin(sourceRepo().dir)).rejects.toThrow('not a bare repository');
    await expect(localOrigin('https://github.com/a/b.git')).rejects.toThrow('not a local directory');
  });
});

describe('localPulls', () => {
  it("answers the default branch from the origin's HEAD and records pull requests", async () => {
    const bare = bareOrigin();
    const file = join(temp('pulls'), 'pulls.jsonl');
    const gh = localPulls(bare, file);
    expect(await gh('GET', '/repos/a/b')).toEqual({ default_branch: 'main' });
    const pull = await gh<{ number: number; html_url: string }>('POST', '/repos/a/b/pulls', { title: 't', head: 'x' });
    expect(pull).toMatchObject({ number: 1, html_url: `${bare}#pull/1` });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ number: 1, title: 't', head: 'x' });
    expect(await gh('GET', '/repos/a/b/pulls?head=a%3Ax&state=open')).toMatchObject([{ number: 1, head: 'x' }]);
    expect(await gh('GET', '/repos/a/b/pulls?head=a%3Ay&state=open')).toEqual([]);
    await expect(gh('DELETE', '/repos/a/b')).rejects.toThrow('no local equivalent');
  });
});

describe('serveHub', () => {
  it('runs the jobs an issue comment starts, applies the reply and serves the runs', async () => {
    const hub = temp('serve-hub');
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(hub, path, '..'), { recursive: true });
      writeFileSync(join(hub, path), text);
    }
    const data = temp('serve-data');
    const done: [BotEvent, JobResult[]][] = [];
    const served = await serveHub({
      hub,
      data,
      origin: bareOrigin(),
      repo: 'acme/app',
      env: {},
      port: 0,
      interval: 20,
      log: () => {},
      adapters: { opencode: { name: 'opencode', ...adapter }, pi: { name: 'pi', ...adapter } },
      launch: unsandboxed,
      onResults: (event, results) => done.push([event, results]),
    });
    try {
      await localIssues(join(hub, 'issues'), { repo: 'acme/app', as: 'morgan' }).comment(1, '/bothub why');
      while (!done.length) await new Promise(r => setTimeout(r, 20));
      const [[event, results]] = done as [[BotEvent, JobResult[]]];
      expect(event).toMatchObject({ trigger: 'issue_comment', number: 1, repo: 'acme/app' });
      expect(results.map(r => ('run' in r ? r.run.status : r.skipped))).toEqual(['succeeded']);
      expect(readFileSync(join(hub, 'issues', '1-question.md'), 'utf8')).toContain('Because.');
      const res = await fetch(`http://127.0.0.1:${served.port}/api/runs`);
      expect((await res.json()).map((r: { job: string }) => r.job)).toEqual(['answer']);
      const again = await localIssues(join(hub, 'issues'), { repo: 'acme/app' }).get(1);
      expect(again?.comments).toHaveLength(2);
    } finally {
      await served.stop();
    }
  });

  it('keeps serving through a hub edit that does not compile, and runs again once it is fixed', async () => {
    const hub = temp('serve-hub');
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(hub, path, '..'), { recursive: true });
      writeFileSync(join(hub, path), text);
    }
    const lines: string[] = [];
    const done: JobResult[][] = [];
    const served = await serveHub({
      hub,
      data: temp('serve-data'),
      origin: bareOrigin(),
      repo: 'acme/app',
      env: {},
      port: 0,
      interval: 20,
      log: line => lines.push(line),
      adapters: { opencode: { name: 'opencode', ...adapter }, pi: { name: 'pi', ...adapter } },
      launch: unsandboxed,
      onResults: (_, results) => done.push(results),
    });
    const issues = localIssues(join(hub, 'issues'), { repo: 'acme/app', as: 'morgan' });
    const settle = async (check: () => boolean) => {
      while (!check()) await new Promise(r => setTimeout(r, 20));
      await served.idle();
    };
    try {
      writeFileSync(join(hub, 'bots/helper.md'), files['bots/helper.md']!.replace('tools: [read]', 'tools: [Read]'));
      await issues.comment(1, '/bothub why');
      await settle(() => lines.some(line => line.startsWith('hub: bots/helper.md')));
      expect(done).toEqual([]);

      writeFileSync(join(hub, 'bots/helper.md'), files['bots/helper.md']!);
      await issues.comment(1, '/bothub why, again');
      await settle(() => done.length > 0);
      expect(done.flat().map(r => ('run' in r ? r.run.status : r.skipped))).toEqual(['succeeded']);
    } finally {
      await served.stop();
    }
  });

  it('runs a comment made while it was stopped, but not what was there on its first start', async () => {
    const hub = temp('serve-hub');
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(hub, path, '..'), { recursive: true });
      writeFileSync(join(hub, path), text);
    }
    const data = temp('serve-data');
    const issues = localIssues(join(hub, 'issues'), { repo: 'acme/app', as: 'morgan' });
    await issues.comment(1, '/bothub from before the first start');
    const done: [BotEvent, JobResult[]][] = [];
    const start = () =>
      serveHub({
        hub,
        data,
        origin: bareOrigin(),
        repo: 'acme/app',
        env: {},
        port: 0,
        interval: 20,
        log: () => {},
        adapters: { opencode: { name: 'opencode', ...adapter }, pi: { name: 'pi', ...adapter } },
        launch: unsandboxed,
        onResults: (event, results) => done.push([event, results]),
      });
    const first = await start();
    await first.idle();
    await first.stop();
    expect(done).toEqual([]);

    await issues.comment(1, '/bothub while stopped');
    const second = await start();
    try {
      while (!done.length) await new Promise(r => setTimeout(r, 20));
      await second.idle();
      expect(done.map(([event]) => event.body)).toEqual(['/bothub while stopped']);
    } finally {
      await second.stop();
    }
    const third = await start();
    await third.idle();
    await third.stop();
    expect(done).toHaveLength(1);
  });

  it('marks runs a stopped process left unfinished as interrupted and runs their event again', async () => {
    const hub = temp('serve-hub');
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(hub, path, '..'), { recursive: true });
      writeFileSync(join(hub, path), text);
    }
    const data = temp('serve-data');
    const event: BotEvent = {
      id: 'local-1-comment-0-x',
      ts: '2026-10-12T00:00:00.000Z',
      source: 'local',
      trigger: 'issue_comment',
      action: 'created',
      repo: 'acme/app',
      number: 1,
      actor: { login: 'morgan', association: 'OWNER' },
      body: '/bothub why',
    };
    const gone = openStore(data, { pid: 2 ** 22 + 1, token: 'gone' });
    const stale = await gone.create({ workflow: 'issue', job: 'answer', bot: 'helper', harness: 'opencode', event });
    await gone.update(stale.id, { status: 'running', startedAt: event.ts });
    const done: JobResult[][] = [];
    const served = await serveHub({
      hub,
      data,
      origin: bareOrigin(),
      repo: 'acme/app',
      env: {},
      port: 0,
      interval: 20,
      log: () => {},
      adapters: { opencode: { name: 'opencode', ...adapter }, pi: { name: 'pi', ...adapter } },
      launch: unsandboxed,
      onResults: (_, results) => done.push(results),
    });
    try {
      await served.idle();
      expect((await openStore(data).read(stale.id))?.status).toBe('interrupted');
      expect(done.flat().map(r => ('run' in r ? r.run.status : r.skipped))).toEqual(['succeeded']);
    } finally {
      await served.stop();
    }
  });
});
