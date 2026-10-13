import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localIssues } from '../src/issues-local.ts';
import { checkLine, laneOf, localOrigin, serveHub } from '../src/serve.ts';
import { fileQueue } from '../src/queue.ts';
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

  it('keeps an event that meets a hub edit that does not compile, and runs it once the hub is fixed', async () => {
    const hub = temp('serve-hub');
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(hub, path, '..'), { recursive: true });
      writeFileSync(join(hub, path), text);
    }
    const lines: string[] = [];
    const done: [BotEvent, JobResult[]][] = [];
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
      onResults: (event, results) => done.push([event, results]),
      retry: { backoff: () => 300 },
    });
    const issues = localIssues(join(hub, 'issues'), { repo: 'acme/app', as: 'morgan' });
    try {
      writeFileSync(join(hub, 'bots/helper.md'), files['bots/helper.md']!.replace('tools: [read]', 'tools: [Read]'));
      await issues.comment(1, '/bothub why');
      while (!lines.some(line => line.includes('the hub does not compile'))) await new Promise(r => setTimeout(r, 20));
      expect(lines.some(line => line.startsWith('hub: bots/helper.md'))).toBe(true);
      expect(done).toEqual([]);

      writeFileSync(join(hub, 'bots/helper.md'), files['bots/helper.md']!);
      await issues.comment(1, '/bothub why, again');
      while (done.length < 2) await new Promise(r => setTimeout(r, 20));
      await served.idle();
      expect(done.map(([event, results]) => [event.body, results.map(r => 'run' in r && r.run.status)])).toEqual([
        ['/bothub why', ['succeeded']],
        ['/bothub why, again', ['succeeded']],
      ]);
    } finally {
      await served.stop();
    }
  });

  it('moves an event that keeps failing to the failed items', async () => {
    const hub = temp('serve-hub');
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(hub, path, '..'), { recursive: true });
      writeFileSync(join(hub, path), text);
    }
    writeFileSync(join(hub, 'bots/helper.md'), 'not a bot');
    const data = temp('serve-data');
    const served = await serveHub({
      hub,
      data,
      origin: bareOrigin(),
      repo: 'acme/app',
      env: {},
      port: 0,
      interval: 20,
      log: () => {},
      launch: unsandboxed,
      retry: { tries: 2, backoff: () => 10 },
    });
    try {
      await localIssues(join(hub, 'issues'), { repo: 'acme/app', as: 'morgan' }).comment(1, '/bothub why');
      const queue = fileQueue<BotEvent>(join(data, 'queue'));
      while (!(await queue.failed()).length) await new Promise(r => setTimeout(r, 20));
      const [failed] = await queue.failed();
      expect(failed).toMatchObject({ item: { body: '/bothub why' }, tries: 2 });
      expect(failed?.error).toMatch(/^the hub does not compile/);
      expect(await queue.list()).toEqual([]);
    } finally {
      await served.stop();
    }
  });

  it('runs two issues at once and leaves events a bot made that start nothing out of the queue', async () => {
    const hub = temp('serve-hub');
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(hub, path, '..'), { recursive: true });
      writeFileSync(join(hub, path), text);
    }
    writeFileSync(
      join(hub, 'issues/2-other.md'),
      '---\ntitle: Another\nstate: open\nlabels: []\nauthor: morgan\n---\n\nHow?\n'
    );
    const timed = {
      command: () => ({
        cmd: process.execPath,
        args: ['-e', `setTimeout(() => console.log(${JSON.stringify(reply)}), 300)`],
        env: {},
      }),
      parseLine: adapter.parseLine,
    };
    const lines: string[] = [];
    const data = temp('serve-data');
    const served = await serveHub({
      hub,
      data,
      origin: bareOrigin(),
      repo: 'acme/app',
      env: {},
      port: 0,
      interval: 20,
      log: line => lines.push(line),
      adapters: { opencode: { name: 'opencode', ...timed }, pi: { name: 'pi', ...timed } },
      launch: unsandboxed,
    });
    try {
      const issues = localIssues(join(hub, 'issues'), { repo: 'acme/app', as: 'morgan' });
      await issues.comment(1, '/bothub one');
      await issues.comment(2, '/bothub two');
      while (lines.filter(line => line.startsWith('issue/answer: succeeded')).length < 2)
        await new Promise(r => setTimeout(r, 20));
      await served.idle();
      const runs = await openStore(data).list();
      const [a, b] = runs.map(r => [Date.parse(r.startedAt!), Date.parse(r.endedAt!)] as const);
      expect(a![0] < b![1] && b![0] < a![1]).toBe(true);
      expect(lines.filter(line => line.includes('by @bothub[bot]: 0 jobs'))).toHaveLength(2);
      expect(await fileQueue(join(data, 'queue')).list()).toEqual([]);
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

describe('checkLine and laneOf', () => {
  it('names a check start and its verdict with its time, and keeps one lane per issue', () => {
    const run = { workflow: 'pr', job: 'fix', id: 'r1' } as Parameters<typeof checkLine>[0];
    const verdict = { check: 'tests', gating: true, pass: false };
    expect(checkLine(run, 'tests')).toBe('pr/fix r1 check tests start');
    expect(checkLine(run, 'tests', { ...verdict, pass: true, durationMs: 1234 })).toBe(
      'pr/fix r1 check tests pass in 1.2s'
    );
    expect(checkLine(run, 'tests', { ...verdict, blocked: true })).toBe('pr/fix r1 check tests blocked');
    expect(checkLine(run, 'tests', { ...verdict, skipped: true })).toBe('pr/fix r1 check tests skipped');
    expect(checkLine(run, 'tests', verdict)).toBe('pr/fix r1 check tests fail');
    const event = { repo: 'acme/app', number: 3 } as BotEvent;
    expect(laneOf({ id: 'e1', item: event })).toBe('acme/app#3');
    expect(laneOf({ id: 'e2', item: { repo: 'acme/app' } as BotEvent })).toBe('acme/app#e2');
  });
});
