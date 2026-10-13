import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { compile } from '../src/config.ts';
import { plan, withdrawn } from '../src/dispatch.ts';
import { toEvent } from '../src/github.ts';
import { localIssues } from '../src/issues-local.ts';
import { fileQueue, worker } from '../src/queue.ts';
import { unsandboxed } from '../src/runner.ts';
import { serveHub } from '../src/serve.ts';
import type { BotEvent } from '../src/types.ts';
import { git, sourceRepo, temp } from './git.ts';

const exec = promisify(execFile);
const until = async (check: () => boolean) => {
  for (let i = 0; i < 400 && !check(); i++) await new Promise(done => setTimeout(done, 5));
};

describe('fileQueue', () => {
  it('takes items in push order, once each, and accepts an id again after it is done', async () => {
    const dir = temp('queue');
    const q = fileQueue<{ n: number }>(dir);
    for (const n of [1, 2, 3]) expect(await q.push(`e${n}`, { n })).toBe(true);
    expect(await q.push('e2', { n: 99 })).toBe(false);

    const first = await q.take();
    expect(first).toMatchObject({ id: 'e1', item: { n: 1 } });
    expect(await q.push('e1', { n: 99 })).toBe(false);
    expect((await q.list()).map(e => [e.id, e.taken !== undefined])).toEqual([
      ['e1', true],
      ['e2', false],
      ['e3', false],
    ]);

    await q.done('e1');
    expect(await q.push('e1', { n: 4 })).toBe(true);
    const order: number[] = [];
    for (let next; (next = await q.take()); await q.done(next.id)) order.push(next.item.n);
    expect(order).toEqual([2, 3, 4]);
    expect(await q.list()).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('never hands one item to two processes racing on the same directory', async () => {
    const dir = temp('queue');
    const q = fileQueue<number>(dir);
    const ids = Array.from({ length: 60 }, (_, i) => `e${i}`);
    for (const [i, id] of ids.entries()) await q.push(id, i);

    const script = `
      import { fileQueue } from ${JSON.stringify(resolve('src/queue.ts'))};
      const q = fileQueue(process.argv[1]);
      const got = [];
      for (let next; (next = await q.take()); await q.done(next.id)) got.push(next.id);
      console.log(JSON.stringify(got));
    `;
    const workers = await Promise.all(
      Array.from({ length: 4 }, () =>
        exec(process.execPath, ['--input-type=module', '-e', script, dir], {
          env: { ...process.env, NODE_OPTIONS: '' },
        })
      )
    );
    const taken = workers.flatMap(({ stdout }) => JSON.parse(stdout) as string[]);
    expect(taken.toSorted()).toEqual(ids.toSorted());
    expect(readdirSync(dir)).toEqual([]);
  });

  it('returns items taken by a process that is gone, and leaves those of a live one', async () => {
    const dir = temp('queue');
    const dead = fileQueue<string>(dir, { pid: 2 ** 22 + 1, token: 'gone' });
    const other = fileQueue<string>(dir, { pid: process.ppid, token: 'other' });
    await dead.push('a', 'from a dead process');
    await other.push('b', 'from a live process');
    await dead.push('c', 'waiting');
    expect((await dead.take())?.id).toBe('a');
    expect((await other.take())?.id).toBe('b');

    const restarted = fileQueue<string>(dir);
    expect((await restarted.list()).map(e => [e.id, e.taken?.token])).toEqual([
      ['a', undefined],
      ['b', 'other'],
      ['c', undefined],
    ]);
    expect(await restarted.push('a', 'again')).toBe(false);
    expect((await restarted.take())?.item).toBe('from a dead process');
    expect((await restarted.take())?.item).toBe('waiting');
    expect(await restarted.take()).toBeUndefined();
  });

  it('keeps push order across queues on one directory within the same millisecond', async () => {
    const dir = temp('queue');
    const queues = [fileQueue<string>(dir), fileQueue<string>(dir)];
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 12));
    const ids = ['f', 'e', 'd', 'c', 'b', 'a'];
    try {
      for (const [i, id] of ids.entries()) await queues[i % 2]?.push(id, id);
    } finally {
      now.mockRestore();
    }
    expect((await queues[0]?.list())?.map(e => e.id)).toEqual(ids);
  });

  it('ignores files that are not items', async () => {
    const dir = temp('queue');
    writeFileSync(join(dir, 'README'), 'not an item');
    const q = fileQueue<string>(dir);
    expect(await q.take()).toBeUndefined();
    expect(await q.list()).toEqual([]);
  });
});

describe('worker', () => {
  it('runs items one after another, moves a failing one aside and picks up pushes made while draining', async () => {
    const q = fileQueue<string>(temp('queue'));
    const ran: string[] = [];
    const errors: string[] = [];
    let running = 0;
    let most = 0;
    const work = worker(
      q,
      async item => {
        most = Math.max(most, ++running);
        await new Promise(done => setTimeout(done, 5));
        running--;
        if (item === 'bad') throw new Error('bad item');
        ran.push(item);
        if (item === 'a') {
          await q.push('c', 'c');
          void work.wake();
        }
      },
      e => errors.push(e.message),
      { tries: 1 }
    );
    await q.push('a', 'a');
    await q.push('bad', 'bad');
    void work.wake();
    await q.push('b', 'b');
    void work.wake();
    await work.idle();
    expect(ran).toEqual(['a', 'b', 'c']);
    expect(errors).toEqual(['bad: bad item; failed 1 times, moved to the failed items']);
    expect(most).toBe(1);
    expect(await q.list()).toEqual([]);
    expect(await q.failed()).toEqual([{ id: 'bad', item: 'bad', tries: 1, error: 'bad item' }]);
  });

  it('runs items of different lanes at once and keeps each lane in push order', async () => {
    const q = fileQueue<{ issue: number; n: number }>(temp('queue'));
    const log: string[] = [];
    let running = 0;
    let most = 0;
    const work = worker(
      q,
      async ({ issue, n }) => {
        most = Math.max(most, ++running);
        log.push(`start ${issue}.${n}`);
        await new Promise(done => setTimeout(done, issue === 1 ? 40 : 5));
        log.push(`end ${issue}.${n}`);
        running--;
      },
      () => {},
      { concurrency: 3, key: entry => String(entry.item.issue) }
    );
    for (const [issue, n] of [
      [1, 1],
      [1, 2],
      [2, 1],
      [3, 1],
      [2, 2],
    ] as const)
      await q.push(`${issue}.${n}`, { issue, n });
    void work.wake();
    await work.idle();
    expect(most).toBe(3);
    const at = (line: string) => log.indexOf(line);
    expect(at('start 1.2')).toBeGreaterThan(at('end 1.1'));
    expect(at('start 2.2')).toBeGreaterThan(at('end 2.1'));
    expect(at('start 2.2')).toBeLessThan(at('end 1.1'));
    expect(await q.list()).toEqual([]);
  });

  it('tries a failing item again after its backoff, holding its lane, then moves it to the failed items', async () => {
    const q = fileQueue<{ issue: number; n: number }>(temp('queue'));
    const ran: string[] = [];
    const errors: string[] = [];
    let flaky = 2;
    const work = worker(
      q,
      async ({ issue, n }) => {
        ran.push(`${issue}.${n}`);
        if (issue === 1 && n === 1 && flaky-- > 0) throw new Error('hub broken');
        if (issue === 2) throw new Error('always');
      },
      e => errors.push(e.message),
      { concurrency: 2, key: entry => String(entry.item.issue), tries: 3, backoff: n => n * 10 }
    );
    await q.push('1.1', { issue: 1, n: 1 });
    await q.push('1.2', { issue: 1, n: 2 });
    await q.push('2.1', { issue: 2, n: 1 });
    void work.wake();
    await work.idle();
    expect(ran.filter(r => r.startsWith('1.'))).toEqual(['1.1', '1.1', '1.1', '1.2']);
    expect(ran.filter(r => r === '2.1')).toHaveLength(3);
    expect(errors).toContain('1.1: hub broken; trying again in 0s');
    expect(errors).toContain('2.1: always; failed 3 times, moved to the failed items');
    expect(await q.list()).toEqual([]);
    expect(await q.failed()).toEqual([{ id: '2.1', item: { issue: 2, n: 1 }, tries: 3, error: 'always' }]);
  });

  it('finishes the running item on stop and leaves the rest queued', async () => {
    const q = fileQueue<string>(temp('queue'));
    const ran: string[] = [];
    let started = false;
    const work = worker(
      q,
      async item => {
        started = true;
        await new Promise(done => setTimeout(done, 20));
        ran.push(item);
      },
      () => {}
    );
    await q.push('a', 'a');
    await q.push('b', 'b');
    void work.wake();
    await until(() => started);
    await work.stop();
    expect(ran).toEqual(['a']);
    expect((await q.list()).map(e => e.id)).toEqual(['b']);
    await work.wake();
    expect(ran).toEqual(['a']);
  });
});

describe('label assignment', () => {
  const workflow = [
    '---',
    'name: assigned',
    'on:',
    '  issues:',
    '    types: [labeled]',
    '    labels: [bot:helper]',
    'jobs:',
    '  work: { type: script, run: echo }',
    '---',
    '',
  ].join('\n');

  it('starts a workflow when its label is added and withdraws it once the label is removed', async () => {
    const compiled = compile([{ path: 'workflows/assigned.md', source: workflow }]);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
    const dir = temp('issues');
    writeFileSync(join(dir, '1-task.md'), '---\ntitle: Task\nauthor: morgan\n---\n\nDo it.\n');
    const issues = localIssues(dir, { repo: 'acme/app', as: 'morgan' });
    const events: BotEvent[] = [];
    const watching = issues.watch(e => events.push(e), { interval: 5 });
    await watching.ready;
    try {
      await issues.label(1, { add: ['bot:helper', 'p1'] });
      await until(() => events.length >= 2);
      expect(events.map(e => [e.action, e.label, plan(e, compiled.config).map(j => j.job)])).toEqual([
        ['labeled', 'bot:helper', ['work']],
        ['labeled', 'p1', []],
      ]);
      expect(new Set(events.map(e => e.id)).size).toBe(2);
      const [assigned] = events as [BotEvent];
      expect(await withdrawn(assigned, issues)).toBe(false);

      await issues.label(1, { remove: ['bot:helper'] });
      expect(await withdrawn(assigned, issues)).toBe(true);
      await new Promise(done => setTimeout(done, 40));
      await issues.label(1, { add: ['bot:helper'] });
      await until(() => events.length >= 3);
      expect(events[2]).toMatchObject({ action: 'labeled', label: 'bot:helper' });
      expect(events[2]?.id).not.toBe(assigned.id);
      expect(await withdrawn(assigned, issues)).toBe(false);
    } finally {
      watching.stop();
    }
  });

  it('reads the label of a GitHub labeled delivery the same way', async () => {
    const compiled = compile([{ path: 'workflows/assigned.md', source: workflow }]);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
    const payload = (label: string) => ({
      action: 'labeled',
      repository: { full_name: 'acme/app' },
      sender: { login: 'morgan' },
      label: { name: label },
      issue: {
        number: 4,
        html_url: 'https://github.com/acme/app/issues/4',
        body: '',
        user: { login: 'morgan' },
        author_association: 'OWNER',
      },
    });
    const event = toEvent('issues', 'd1', payload('bot:helper'));
    expect(event?.label).toBe('bot:helper');
    expect(plan(event!, compiled.config)).toEqual([{ workflow: 'assigned', job: 'work' }]);
    expect(plan(toEvent('issues', 'd2', payload('bug'))!, compiled.config)).toEqual([]);
    expect(await withdrawn({ ...event!, action: 'unlabeled' }, { get: async () => undefined })).toBe(false);
  });
});

describe('serveHub queue', () => {
  it('runs what a stopped process left queued, minus events whose label was removed, then assigned issues', async () => {
    const hub = temp('serve-hub');
    const write = (path: string, text: string) => {
      mkdirSync(join(hub, path, '..'), { recursive: true });
      writeFileSync(join(hub, path), text);
    };
    write('hub.yaml', 'issues: local\n');
    write(
      'workflows/assigned.md',
      '---\nname: assigned\non:\n  issues: { types: [labeled], labels: [bot:helper] }\njobs:\n  work: { type: script, run: echo }\n---\n'
    );
    for (const n of [1, 2, 3])
      write(`issues/${n}-task.md`, `---\ntitle: Task\nauthor: morgan\nlabels: [${n === 1 ? 'bot:helper' : ''}]\n---\n`);
    const { dir } = sourceRepo();
    const origin = join(temp('bare'), 'app.git');
    git(dir, 'clone', '-q', '--bare', dir, origin);

    const data = temp('serve-data');
    const labeled = (number: number): BotEvent => ({
      id: `before-${number}`,
      ts: '2026-10-12T00:00:00.000Z',
      source: 'local',
      trigger: 'issues',
      action: 'labeled',
      repo: 'acme/app',
      number,
      actor: { login: 'morgan', association: 'OWNER' },
      label: 'bot:helper',
    });
    const before = fileQueue<BotEvent>(join(data, 'queue'), { pid: 2 ** 22 + 1, token: 'gone' });
    await before.push('before-1', labeled(1));
    await before.push('before-2', labeled(2));
    await before.take();

    const ran: [number | undefined, string[]][] = [];
    const lines: string[] = [];
    const served = await serveHub({
      hub,
      data,
      origin,
      repo: 'acme/app',
      env: {},
      port: 0,
      interval: 10,
      log: line => lines.push(line),
      launch: unsandboxed,
      onResults: (event, results) =>
        ran.push([event.number, results.map(r => ('run' in r ? r.run.status : r.skipped))]),
    });
    try {
      await served.idle();
      expect(ran).toEqual([[1, ['succeeded']]]);
      expect(lines).toContain('event before-2 dropped, its label "bot:helper" was removed');

      await localIssues(join(hub, 'issues'), { repo: 'acme/app', as: 'morgan' }).label(3, { add: ['bot:helper'] });
      await until(() => ran.length >= 2);
      await served.idle();
      expect(ran).toEqual([
        [1, ['succeeded']],
        [3, ['succeeded']],
      ]);
      expect(await fileQueue(join(data, 'queue')).list()).toEqual([]);
    } finally {
      await served.stop();
    }
  });
});
