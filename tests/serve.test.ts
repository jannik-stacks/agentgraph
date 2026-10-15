import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localIssues } from '../src/issues-local.ts';
import { localPulls } from '../src/pulls.ts';
import { checkLine, laneOf, localOrigin, logExit, serveHub, warmDeps } from '../src/serve.ts';
import { rpc, type OpError } from '../src/ops.ts';
import { unsandboxed } from '../src/runner.ts';
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
  const hubDir = (extra: Record<string, string> = {}) => {
    const hub = temp('serve-hub');
    for (const [path, text] of Object.entries({ ...files, ...extra })) {
      mkdirSync(join(hub, path, '..'), { recursive: true });
      writeFileSync(join(hub, path), text);
    }
    return hub;
  };
  const start = async (options: Partial<Parameters<typeof serveHub>[0]> & { hub: string }) => {
    const done: [BotEvent, JobResult[]][] = [];
    const lines: string[] = [];
    const served = await serveHub({
      data: temp('serve-data'),
      origin: bareOrigin(),
      repo: 'acme/app',
      env: {},
      port: 0,
      log: line => lines.push(line),
      adapters,
      launch: unsandboxed,
      onResults: (event, results) => done.push([event, results]),
      ...options,
    });
    const call = rpc(`http://127.0.0.1:${served.port}`);
    const say = (issue: number, text: string, as = 'morgan') => call('say', { issue, text, as });
    const ran = async (n: number) => {
      while (done.length < n) await new Promise(r => setTimeout(r, 20));
      await served.idle();
    };
    return { served, done, lines, call, say, ran };
  };

  it('runs what a message starts, applies the reply and serves the runs as ops', async () => {
    const hub = hubDir();
    const { served, done, call, say, ran } = await start({ hub });
    try {
      expect(await say(1, '/bothub why')).toMatchObject({ jobs: ['issue/answer'] });
      await ran(1);
      const [[event, results]] = done as [[BotEvent, JobResult[]]];
      expect(event).toMatchObject({ trigger: 'issue_comment', number: 1, repo: 'acme/app', body: '/bothub why' });
      expect(results.map(r => r.run.status)).toEqual(['succeeded']);
      const issue = await localIssues(join(hub, 'issues'), { repo: 'acme/app' }).get(1);
      expect(issue?.comments.map(c => [c.author, c.body.split('\n')[0]])).toEqual([
        ['morgan', '/bothub why'],
        ['bothub[bot]', 'Because.'],
      ]);
      const runs = (await call('runs_list')) as { id: string; job: string }[];
      expect(runs.map(r => r.job)).toEqual(['answer']);
      expect(await call('runs_get', { id: runs[0]!.id })).toMatchObject({ run: { job: 'answer' } });
      await expect(call('runs_get', { id: 'nope' })).rejects.toThrow('no run "nope"');
      await expect(call('say', { text: 'hi' })).rejects.toThrow('name either an issue or a merge request');
    } finally {
      await served.stop();
    }
  });

  it('starts nothing from a bot, and answers a mention that starts nothing', async () => {
    const hub = hubDir({
      'workflows/issue.md': files['workflows/issue.md']!.replace('command: /bothub', 'command: /ask'),
    });
    const { served, say } = await start({ hub });
    try {
      expect(await say(1, '/ask why', 'helper[bot]')).toBeNull();
      expect(await say(1, '@bothub can you look?')).toMatchObject({ jobs: [] });
      const issue = await localIssues(join(hub, 'issues'), { repo: 'acme/app' }).get(1);
      expect(issue?.comments.at(-1)).toMatchObject({
        author: 'bothub[bot]',
        body: 'Nothing starts on this. Start a comment with /ask.',
      });
    } finally {
      await served.stop();
    }
  });

  it('records the engine and hub on every run, keeps each hub version and logs its keys and every hub change', async () => {
    const hub = hubDir();
    const data = temp('serve-data');
    const { served, done, lines, say, ran } = await start({
      hub,
      data,
      env: { BOTHUB_LLM_API_KEY: 'k1', BOTHUB_LLM_API_KEY_OTHER: 'k2' },
    });
    try {
      expect(lines[0]).toBe('model keys: BOTHUB_LLM_API_KEY (helper), BOTHUB_LLM_API_KEY_OTHER');
      await say(1, '/bothub why');
      await ran(1);
      const first = done[0]![1][0]!.run;
      expect(first.engine?.src).toMatch(/^[0-9a-f]{16}$/);
      expect(lines).toContain(`hub ${first.hub}`);
      const kept = JSON.parse(readFileSync(join(data, 'hubs', `${first.hub}.json`), 'utf8'));
      expect(Object.keys(kept).sort()).toEqual(
        Object.keys(files)
          .filter(f => !f.startsWith('issues/'))
          .sort()
      );
      expect(readdirSync(join(data, 'runs', first.id)).sort()).toEqual(
        expect.arrayContaining(['events.jsonl', 'prompt.md', 'run.json', 'spans.jsonl'])
      );
      writeFileSync(
        join(hub, 'skills/answer.md'),
        files['skills/answer.md']!.replace('Answer it.', 'Answer it briefly.')
      );
      await say(1, '/bothub again');
      await ran(2);
      const second = done[1]![1][0]!.run;
      expect(second.hub).not.toBe(first.hub);
      expect(second.previous).toBe(first.id);
      expect(lines).toContain(`hub ${first.hub} -> ${second.hub}: skills/answer.md +1 -1`);
    } finally {
      await served.stop();
    }
  });

  it('stops a run on request and defers its work', async () => {
    const hanging = fakeHarness(() => ({
      events: [reply],
      work: 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000)',
    }));
    const { served, done, call, say, ran } = await start({ hub: hubDir(), adapters: hanging.adapters });
    try {
      await say(1, '/bothub why');
      let running: { id: string } | undefined;
      while (
        !(running = ((await call('runs_list')) as { id: string; status: string }[]).find(r => r.status === 'running'))
      )
        await new Promise(r => setTimeout(r, 20));
      const stop = () =>
        call('runs_stop', { id: running!.id }).then(
          () => 200,
          (e: OpError) => e.status
        );
      let status;
      while ((status = await stop()) === 409) await new Promise(r => setTimeout(r, 20));
      expect(status).toBe(200);
      await ran(1);
      expect(done[0]![1][0]!.run).toMatchObject({ status: 'cancelled', stopped: 'human', closure: 'deferred' });
    } finally {
      await served.stop();
    }
  });

  it('holds work while paused and starts it on resume', async () => {
    const { served, done, call, say, ran } = await start({ hub: hubDir() });
    try {
      expect(await call('pause', {})).toEqual({ paused: true, stopped: [] });
      expect(await say(1, '/bothub later')).toMatchObject({ jobs: ['issue/answer'], held: true });
      await served.idle();
      expect(done).toEqual([]);
      expect(await call('status')).toMatchObject({ paused: true, held: [{ issue: 1 }], live: [] });
      expect(await call('resume')).toMatchObject({ started: [{ jobs: ['issue/answer'] }] });
      await ran(1);
      expect(done.map(([event]) => event.body)).toEqual(['/bothub later']);
      expect(await call('status')).toMatchObject({ paused: false, held: [] });
    } finally {
      await served.stop();
    }
  });

  it('triggers a named workflow on an issue with its text as arguments', async () => {
    const { served, done, call, ran } = await start({ hub: hubDir() });
    try {
      await expect(call('trigger', { issue: 1 })).rejects.toThrow('name a workflow or give the comment text');
      await expect(call('trigger', { issue: 1, workflow: 'nope' })).rejects.toThrow('no workflow "nope"');
      expect(await call('trigger', { issue: 1, workflow: 'issue', text: 'why' })).toMatchObject({
        jobs: ['issue/answer'],
      });
      await ran(1);
      expect(done[0]![0]).toMatchObject({ trigger: 'workflow_dispatch', number: 1, body: 'why' });
      expect(done[0]![1].map(r => r.args)).toEqual(['why']);
    } finally {
      await served.stop();
    }
  });

  it('runs a message with the last hub that compiled, and reports the broken edit on /api/info', async () => {
    const hub = hubDir();
    const { served, done, lines, say, ran } = await start({ hub });
    const info = async () =>
      (await (await fetch(`http://127.0.0.1:${served.port}/api/info`)).json()) as { hubErrors: unknown[] };
    try {
      await say(1, '/bothub one');
      await ran(1);
      expect((await info()).hubErrors).toEqual([]);

      writeFileSync(join(hub, 'bots/helper.md'), files['bots/helper.md']!.replace('tools: [read]', 'tools: [Read]'));
      await say(1, '/bothub two');
      await ran(2);
      expect(lines).toContain('the hub does not compile (1 errors), running the last version that compiled');
      expect((await info()).hubErrors).toMatchObject([{ path: 'bots/helper.md' }]);

      writeFileSync(join(hub, 'bots/helper.md'), files['bots/helper.md']!);
      await say(1, '/bothub three');
      await ran(3);
      expect((await info()).hubErrors).toEqual([]);
      expect(done.map(([event]) => event.body)).toEqual(['/bothub one', '/bothub two', '/bothub three']);
    } finally {
      await served.stop();
    }
  });

  it('runs two issues at once', async () => {
    const timed = fakeHarness(() => ({
      events: [reply],
      work: 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)',
    }));
    const data = temp('serve-data');
    const hub = hubDir({
      'issues/2-other.md': '---\ntitle: Another\nstate: open\nlabels: []\nauthor: morgan\n---\n\nHow?\n',
    });
    const { served, say, ran } = await start({ hub, data, adapters: timed.adapters });
    try {
      await say(1, '/bothub one');
      await say(2, '/bothub two');
      await ran(2);
      const runs = await openStore(data).list();
      const [a, b] = runs.map(r => [Date.parse(r.startedAt!), Date.parse(r.endedAt!)] as const);
      expect(a![0] < b![1] && b![0] < a![1]).toBe(true);
    } finally {
      await served.stop();
    }
  });

  it('marks runs a stopped process left unfinished as interrupted and runs them again', async () => {
    const data = temp('serve-data');
    const event: BotEvent = {
      id: 'comment-1',
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
    const { served, done } = await start({ hub: hubDir(), data });
    try {
      await served.idle();
      expect((await openStore(data).read(stale.id))?.status).toBe('interrupted');
      expect(done.flatMap(([, results]) => results).map(r => r.run.status)).toEqual(['succeeded']);
    } finally {
      await served.stop();
    }
  });

  it('starts the event of a merge request once, on start and after each run', async () => {
    const hub = hubDir({
      'workflows/pr.md': [
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
      ].join('\n'),
    });
    const data = temp('serve-data');
    const origin = bareOrigin();
    await localPulls({ origin, file: join(data, 'pulls.jsonl'), repo: 'acme/app' }).open({
      title: 'Feature',
      body: '',
      branch: 'feature',
      into: 'main',
    });
    const { served, done, say, ran } = await start({ hub, data, origin });
    try {
      await ran(1);
      await say(1, '/bothub why');
      await ran(2);
      expect(done.map(([e]) => [e.trigger, e.action ?? null, e.id.startsWith('comment-') ? 'say' : e.id])).toEqual([
        ['pull_request', 'opened', 'local-pull-1-opened'],
        ['issue_comment', 'created', 'say'],
      ]);
    } finally {
      await served.stop();
    }
    const again = await start({ hub, data, origin });
    await again.served.idle();
    await again.served.stop();
    expect(again.done).toEqual([]);
  });

  it('logs a merge request log it cannot read and keeps serving', async () => {
    const data = temp('serve-data');
    writeFileSync(join(data, 'pulls.jsonl'), 'not json\n');
    const { served, done, lines, say, ran } = await start({ hub: hubDir(), data });
    try {
      expect(lines.some(line => line.startsWith('error: ') && line.includes('JSON'))).toBe(true);
      await say(1, '/bothub why');
      await ran(1);
      expect(done.map(([e]) => e.body)).toEqual(['/bothub why']);
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
    expect(laneOf({ id: 'e1', repo: 'acme/app', ...fields } as BotEvent)).toBe(lane);
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

describe('logExit', () => {
  it('logs why and with which code the process exits, an uncaught error first', () => {
    const lines: string[] = [];
    const proc = new EventEmitter();
    const because = logExit(line => lines.push(line), proc);
    proc.emit('uncaughtExceptionMonitor', new Error('boom'));
    because('on SIGTERM');
    proc.emit('exit', 1);
    expect(lines).toEqual(['serve exits on error: boom with code 1']);
    const quiet = new EventEmitter();
    logExit(line => lines.push(line), quiet)('on SIGINT');
    quiet.emit('exit', 0);
    expect(lines[1]).toBe('serve exits on SIGINT with code 0');
  });
});
