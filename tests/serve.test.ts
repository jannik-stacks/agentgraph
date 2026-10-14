import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localIssues } from '../src/issues-local.ts';
import { localPulls } from '../src/pulls.ts';
import { checkLine, laneOf, localOrigin, serveHub, warmDeps } from '../src/serve.ts';
import { fileQueue } from '../src/queue.ts';
import { unsandboxed, type Launcher } from '../src/runner.ts';
import { SandboxError } from '../src/sandbox.ts';
import { openStore } from '../src/store.ts';
import { workspaces } from '../src/workspace.ts';
import type { JobResult } from '../src/pipeline.ts';
import type { AgentEvent, BotEvent } from '../src/types.ts';
import { bareOrigin, commit, fakeHarness, sourceRepo, temp } from './kit.ts';

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

const reply: AgentEvent = { type: 'end', ok: true, result: '```bothub\n[{"kind":"reply","body":"Because."}]\n```' };
const { adapters } = fakeHarness(() => ({ events: [reply] }));

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
      adapters,
      launch: unsandboxed,
      onResults: (event, results) => done.push([event, results]),
    });
    try {
      await localIssues(join(hub, 'issues'), { repo: 'acme/app', as: 'morgan' }).comment(1, '/bothub why');
      while (!done.length) await new Promise(r => setTimeout(r, 20));
      const [[event, results]] = done as [[BotEvent, JobResult[]]];
      expect(event).toMatchObject({ trigger: 'issue_comment', number: 1, repo: 'acme/app' });
      expect(results.map(r => (r.run.status === 'skipped' ? r.run.reason : r.run.status))).toEqual(['succeeded']);
      expect(readFileSync(join(hub, 'issues', '1-question.md'), 'utf8')).toContain('Because.');
      const res = await fetch(`http://127.0.0.1:${served.port}/api/runs`);
      expect((await res.json()).map((r: { job: string }) => r.job)).toEqual(['answer']);
      const again = await localIssues(join(hub, 'issues'), { repo: 'acme/app' }).get(1);
      expect(again?.comments).toHaveLength(2);
    } finally {
      await served.stop();
    }
  });

  it('stops a run it is running when the studio asks, and defers its work', async () => {
    const hub = temp('serve-hub');
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(hub, path, '..'), { recursive: true });
      writeFileSync(join(hub, path), text);
    }
    const hanging = fakeHarness(() => ({
      events: [reply],
      work: 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000)',
    }));
    const data = temp('serve-data');
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
      adapters: hanging.adapters,
      launch: unsandboxed,
      onResults: (_, results) => done.push(results),
    });
    try {
      await localIssues(join(hub, 'issues'), { repo: 'acme/app', as: 'morgan' }).comment(1, '/bothub why');
      const store = openStore(data);
      let running;
      while (!(running = (await store.list()).find(r => r.status === 'running')))
        await new Promise(r => setTimeout(r, 20));
      const stop = () => fetch(`http://127.0.0.1:${served.port}/api/runs/${running.id}/stop`, { method: 'POST' });
      let status;
      while ((status = (await stop()).status) === 409) await new Promise(r => setTimeout(r, 20));
      expect(status).toBe(202);
      while (!done.length) await new Promise(r => setTimeout(r, 20));
      expect(done[0]![0]!.run).toMatchObject({ status: 'cancelled', stopped: 'human', closure: 'deferred' });
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
      adapters,
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
      expect(done.map(([event, results]) => [event.body, results.map(r => r.run.status)])).toEqual([
        ['/bothub why', ['succeeded']],
        ['/bothub why, again', ['succeeded']],
      ]);
    } finally {
      await served.stop();
    }
  });

  it('runs an event with the last hub that compiled, and reports the broken edit on /api/info', async () => {
    const hub = temp('serve-hub');
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(hub, path, '..'), { recursive: true });
      writeFileSync(join(hub, path), text);
    }
    const lines: string[] = [];
    const done: BotEvent[] = [];
    const served = await serveHub({
      hub,
      data: temp('serve-data'),
      origin: bareOrigin(),
      repo: 'acme/app',
      env: {},
      port: 0,
      interval: 20,
      log: line => lines.push(line),
      adapters,
      launch: unsandboxed,
      onResults: event => done.push(event),
    });
    const info = async () =>
      (await (await fetch(`http://127.0.0.1:${served.port}/api/info`)).json()) as { hubErrors: unknown[] };
    const issues = localIssues(join(hub, 'issues'), { repo: 'acme/app', as: 'morgan' });
    const ran = async (count: number) => {
      while (done.length < count) await new Promise(r => setTimeout(r, 20));
      await served.idle();
    };
    try {
      await issues.comment(1, '/bothub one');
      await ran(1);
      expect((await info()).hubErrors).toEqual([]);

      writeFileSync(join(hub, 'bots/helper.md'), files['bots/helper.md']!.replace('tools: [read]', 'tools: [Read]'));
      await issues.comment(1, '/bothub two');
      await ran(2);
      expect(lines).toContain('the hub does not compile (1 errors), running the last version that compiled');
      expect((await info()).hubErrors).toMatchObject([{ path: 'bots/helper.md' }]);

      writeFileSync(join(hub, 'bots/helper.md'), files['bots/helper.md']!);
      await issues.comment(1, '/bothub three');
      await ran(3);
      expect((await info()).hubErrors).toEqual([]);
      expect(done.map(event => event.body)).toEqual(['/bothub one', '/bothub two', '/bothub three']);
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

  it('runs an event again when a job did not start', async () => {
    const hub = temp('serve-hub');
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(hub, path, '..'), { recursive: true });
      writeFileSync(join(hub, path), text);
    }
    let starts = 0;
    const flaky: Launcher = {
      ...unsandboxed,
      agent: async (...args) => {
        if (++starts === 1) throw new SandboxError('installing dependencies failed: FETCH_ERROR');
        return unsandboxed.agent(...args);
      },
    };
    const lines: string[] = [];
    const done: JobResult[][] = [];
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
      adapters,
      launch: flaky,
      onResults: (_event, results) => done.push(results),
      retry: { backoff: () => 10 },
    });
    try {
      await localIssues(join(hub, 'issues'), { repo: 'acme/app', as: 'morgan' }).comment(1, '/bothub why');
      while (done.length < 2) await new Promise(r => setTimeout(r, 20));
      await served.idle();
      expect(done.map(results => results.map(r => [r.run.status, r.run.closure]))).toEqual([
        [['failed', 'deferred']],
        [['succeeded', 'done']],
      ]);
      expect(lines).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /issue\/answer did not start: sandbox-failed: installing dependencies failed: FETCH_ERROR; trying again/
          ),
        ])
      );
      const queue = fileQueue<BotEvent>(join(data, 'queue'));
      expect([await queue.list(), await queue.failed()]).toEqual([[], []]);
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
    const timed = fakeHarness(() => ({
      events: [reply],
      work: 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)',
    }));
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
      adapters: timed.adapters,
      launch: unsandboxed,
    });
    try {
      const issues = localIssues(join(hub, 'issues'), { repo: 'acme/app', as: 'morgan' });
      await issues.comment(1, '/bothub one');
      await issues.comment(2, '/bothub two');
      while (lines.filter(line => line.includes('by @bothub[bot]: 0 jobs')).length < 2)
        await new Promise(r => setTimeout(r, 20));
      await served.idle();
      const runs = await openStore(data).list();
      const [a, b] = runs.map(r => [Date.parse(r.startedAt!), Date.parse(r.endedAt!)] as const);
      expect(a![0] < b![1] && b![0] < a![1]).toBe(true);
      expect(lines.filter(line => line.startsWith('issue/answer: succeeded'))).toHaveLength(2);
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
        adapters,
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
      adapters,
      launch: unsandboxed,
      onResults: (_, results) => done.push(results),
    });
    try {
      await served.idle();
      expect((await openStore(data).read(stale.id))?.status).toBe('interrupted');
      expect(done.flat().map(r => (r.run.status === 'skipped' ? r.run.reason : r.run.status))).toEqual(['succeeded']);
    } finally {
      await served.stop();
    }
  });

  it('queues a merge request event once however often it scans', async () => {
    const hub = temp('serve-hub');
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(hub, path, '..'), { recursive: true });
      writeFileSync(join(hub, path), text);
    }
    writeFileSync(
      join(hub, 'workflows/pr.md'),
      [
        '---',
        'name: pr',
        'on:',
        '  pull_request:',
        '    types: [opened]',
        '    guard: { associations: [NONE] }',
        'jobs:',
        '  note:',
        '    type: script',
        '    run: echo seen',
        '    mode: warn',
        '---',
        'Notes.',
        '',
      ].join('\n')
    );
    const data = temp('serve-data');
    const origin = bareOrigin();
    await localPulls({ origin, file: join(data, 'pulls.jsonl'), repo: 'acme/app' }).open({
      title: 'Feature',
      body: '',
      branch: 'feature',
      into: 'main',
    });
    const done: BotEvent[] = [];
    const served = await serveHub({
      hub,
      data,
      origin,
      repo: 'acme/app',
      env: {},
      port: 0,
      interval: 10,
      log: () => {},
      launch: unsandboxed,
      onResults: event => done.push(event),
    });
    try {
      while (!done.length) await new Promise(r => setTimeout(r, 20));
      await new Promise(r => setTimeout(r, 100));
      await served.idle();
      expect(done.map(e => [e.trigger, e.action, e.id])).toEqual([['pull_request', 'opened', 'local-pull-1-opened']]);
      expect(await fileQueue(join(data, 'queue')).list()).toEqual([]);
    } finally {
      await served.stop();
    }
  });

  it('logs a merge request log it cannot read and keeps serving', async () => {
    const hub = temp('serve-hub');
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(hub, path, '..'), { recursive: true });
      writeFileSync(join(hub, path), text);
    }
    const data = temp('serve-data');
    writeFileSync(join(data, 'pulls.jsonl'), 'not json\n');
    const lines: string[] = [];
    const done: BotEvent[] = [];
    const served = await serveHub({
      hub,
      data,
      origin: bareOrigin(),
      repo: 'acme/app',
      env: {},
      port: 0,
      interval: 20,
      log: line => lines.push(line),
      adapters,
      launch: unsandboxed,
      onResults: event => done.push(event),
    });
    try {
      expect(lines.some(line => line.startsWith('error: ') && line.includes('JSON'))).toBe(true);
      await localIssues(join(hub, 'issues'), { repo: 'acme/app', as: 'morgan' }).comment(1, '/bothub why');
      while (!done.length) await new Promise(r => setTimeout(r, 20));
      expect(done.map(e => e.body)).toEqual(['/bothub why']);
    } finally {
      await served.stop();
    }
  });
});

describe('warmDeps', () => {
  const setup = (install: string) => {
    const { dir } = sourceRepo();
    commit(dir, { 'deps.lock': 'v1\n' });
    const origin = bareOrigin(dir);
    const ran = join(temp('deps-log'), 'log');
    const hub = temp('serve-hub');
    const script = JSON.stringify(`echo ran >> ${ran}; ${install}`);
    writeFileSync(
      join(hub, 'hub.yaml'),
      `issues: local\ndeps:\n  install: ${script}\n  lockfiles: [deps.lock]\n  dirs: [vendor]\n`
    );
    const data = temp('serve-data');
    const lines: string[] = [];
    const warm = () =>
      warmDeps({
        hub,
        data,
        repo: 'acme/app',
        workspaces: workspaces({ dataDir: data, cloneUrl: () => origin }),
        launch: unsandboxed,
        log: line => lines.push(line),
      });
    const runs = () => (existsSync(ran) ? readFileSync(ran, 'utf8').split('\n').filter(Boolean).length : 0);
    return { hub, data, lines, warm, runs };
  };

  it('installs the deps once in a worktree it removes afterwards', async () => {
    const { data, lines, warm, runs } = setup('mkdir -p vendor/pkg');
    await warm();
    await warm();
    expect(runs()).toBe(1);
    expect(lines).toEqual(['deps ready', 'deps ready']);
    expect(readdirSync(join(data, 'deps'))).toHaveLength(1);
    expect(readdirSync(join(data, 'work'))).toEqual([]);
  });

  it('logs a failed install and still removes its worktree', async () => {
    const { data, lines, warm, runs } = setup('echo broken; exit 3');
    await expect(warm()).resolves.toBeUndefined();
    expect(runs()).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^deps not prewarmed: installing dependencies failed: [\s\S]*broken/);
    expect(readdirSync(join(data, 'work'))).toEqual([]);
  });

  it('does nothing for a hub without deps', async () => {
    const { hub, data, lines, warm, runs } = setup('true');
    writeFileSync(join(hub, 'hub.yaml'), 'issues: local\n');
    await warm();
    expect(runs()).toBe(0);
    expect(lines).toEqual([]);
    expect(existsSync(join(data, 'work'))).toBe(false);
  });
});

const LANES = [
  ['an issue', { number: 3 }, 'acme/app#3'],
  ['a merge request with the same number', { number: 3, pull: 3 }, 'acme/app!3'],
  ['an issue a merge request comment continues', { number: 3, pull: 9 }, 'acme/app#3'],
  ['an event without a number', {}, 'acme/app#e1'],
] as const;

describe('checkLine and laneOf', () => {
  it.each(LANES)('keeps one lane per issue or merge request: %s', (_, fields, lane) => {
    expect(laneOf({ id: 'e1', item: { repo: 'acme/app', ...fields } as BotEvent })).toBe(lane);
  });

  it('names a check start and its verdict with its time', () => {
    const run = { workflow: 'pr', job: 'fix', id: 'r1' } as Parameters<typeof checkLine>[0];
    const verdict = { check: 'tests', gating: true, pass: false };
    expect(checkLine(run, 'tests')).toBe('pr/fix r1 check tests start');
    expect(checkLine(run, 'tests', { ...verdict, pass: true, durationMs: 1234 })).toBe(
      'pr/fix r1 check tests pass in 1.2s'
    );
    expect(checkLine(run, 'tests', { ...verdict, blocked: true })).toBe('pr/fix r1 check tests blocked');
    expect(checkLine(run, 'tests', { ...verdict, skipped: true })).toBe('pr/fix r1 check tests skipped');
    expect(checkLine(run, 'tests', verdict)).toBe('pr/fix r1 check tests fail');
  });
});
