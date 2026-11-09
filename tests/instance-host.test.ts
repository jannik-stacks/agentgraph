import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Stream } from 'effect';
import { afterEach, expect, it } from 'vitest';
import { runActions } from '../src/actions.ts';
import { makeActionWebHandler, makeInstanceHost, runLocalActions } from '../src/engine.ts';
import { folderTracker, writeIssueFile } from '../src/tracker.ts';
import { stoppedByEngine } from '../src/context.ts';
import { instruct } from '../src/run/trigger.ts';
import { Store } from '../src/store.ts';
import { begin } from '../src/workflow.ts';
import type { Instance } from '../src/instance.ts';
import { makeTestGraph, reply, start } from './fixtures.ts';
import { services, world } from './world.ts';

const folders: string[] = [];
afterEach(() => folders.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

const makeInstance = async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentgraph-instance-host-'));
  folders.push(root);
  const data = join(root, 'data');
  const tracker = join(root, 'tracker');
  mkdirSync(join(data, 'r1'), { recursive: true });
  mkdirSync(tracker);
  writeFileSync(
    join(data, 'r1', 'run.json'),
    JSON.stringify({
      id: 'r1',
      workflow: 'issue',
      step: 'build',
      status: 'done',
      tries: 1,
      rounds: {},
      sessions: {},
      started: '2026-11-01T00:00:00Z',
    })
  );
  const issue = await writeIssueFile(tracker, { title: 'Trend', author: 'morgan', labels: [] }, 'body');
  return { data, tracker, issue };
};

const callLocal = <A, E>(host: ReturnType<typeof makeInstanceHost>, call: Parameters<typeof runActions<A, E>>[2]) =>
  Effect.runPromise(runLocalActions(host, call));
type LocalClient = Parameters<Parameters<typeof runActions>[2]>[0];

it('reads runs, labels and tracker issues of its one instance and acts through the action client', async () => {
  const { data, tracker, issue } = await makeInstance();
  const host = makeInstanceHost(
    { data },
    {
      layer: folderTracker(tracker, 'morgan', ['morgan']),
      origin: { origin: join(tracker, 'origin.git'), local: true },
    }
  );
  const read = await callLocal(host, client =>
    Effect.all({
      records: host.store.listRecords(),
      issues: host.tracker.issues({ state: 'open' }),
      labels: client.label({ id: 'r1', patch: { arm: 'base' } }),
      said: client.say({ issue, text: 'go on' }),
      shown: client.show({ issue }),
    })
  );
  const events = await Effect.runPromise(Stream.runCollect(host.tracker.since('')));
  expect({
    records: read.records.map(run => run.id),
    issues: read.issues.map(i => i.title),
    labels: read.labels,
    shown: read.shown.issues.map(i => i.events?.map(e => e.comment?.body)),
    runs: host.readRuns().map(run => run.labels),
    comments: events.flatMap(event => (event.comment ? [event.comment.body] : [])),
  }).toEqual({
    records: ['r1'],
    issues: ['Trend'],
    labels: { arm: 'base' },
    shown: [['/agent go on']],
    runs: [{ arm: 'base' }],
    comments: ['/agent go on'],
  });
});

it.each([
  ['labels a missing run', (client: LocalClient) => client.label({ id: 'r9', patch: { arm: 'x' } }), 'no run r9'],
  ['reads without a tracker', (client: LocalClient) => client.show({}), 'serves no tracker'],
  ['says without a tracker', (client: LocalClient) => client.say({ issue: 1, text: 'hi' }), 'serves no tracker'],
  [
    'instructs without a drive',
    (client: LocalClient) => client.instruct({ kind: 'resume', parked: true }),
    'serves no instance',
  ],
])('refuses when it %s', async (_name, act, error) => {
  const { data } = await makeInstance();
  await expect(
    callLocal(makeInstanceHost({ data }), act as (c: LocalClient) => Effect.Effect<unknown, unknown>)
  ).rejects.toThrow(error);
});

it('posts nothing on a tracker that is not local, as agi say', async () => {
  const { data, tracker, issue } = await makeInstance();
  const host = makeInstanceHost(
    { data },
    { layer: folderTracker(tracker), origin: { origin: 'https://github.com/o/r' } }
  );
  await expect(callLocal(host, client => client.say({ issue, text: 'hi' }))).rejects.toThrow(
    'this host does not post there'
  );
});

it('resumes a parked run through the engine services the host was given', async () => {
  const where = world();
  const { run } = services(where, [[start('r'), reply()]]);
  const small = makeTestGraph('graph');
  const { branch: _branch, ...unbranched } = small.workflows.issue!;
  const flow = {
    ...unbranched,
    name: 'retro',
    on: { feedback: {} },
    steps: unbranched.steps.map(s => ({ ...s, checks: [] })),
  };
  const graph = { ...small, workflows: { retro: flow } };
  await run(
    Effect.flatMap(Store, store =>
      store.put({
        ...begin(flow, { id: 'retro-7', issue: 7, started: '2026-10-16T00:00:01.000Z' }),
        status: 'waiting',
        reason: `${stoppedByEngine} (SessionStop).`,
        retried: true,
      })
    )
  );
  const host = makeInstanceHost({ data: where.data }, undefined, {
    instance: { tracker: where.tracker, owner: 'local' } as Instance,
    drive: instruction => run(instruct(graph, instruction)),
  });
  const resumed = await callLocal(host, client => client.instruct({ kind: 'resume', parked: true }));
  expect(resumed.map(r => [r.id, r.status, r.retried])).toEqual([['retro-7', 'running', undefined]]);
});

it('refuses a call without a user, even through the same codec or with a forged user header', async () => {
  const { data } = await makeInstance();
  const handle = makeActionWebHandler(makeInstanceHost({ data }));
  const label = { id: 'r1', patch: { arm: 'x' } };
  const viaCodec = Effect.runPromise(
    runActions(
      'http://local/',
      (input, init) => handle(new Request(input, init), undefined),
      client => client.label(label)
    )
  );
  const forged = (headers: string[][]) =>
    handle(
      new Request('http://local/', {
        method: 'POST',
        headers: { 'content-type': 'application/ndjson', 'x-agentgraph-user': 'local' },
        body: `${JSON.stringify({ _tag: 'Request', id: '1', tag: 'label', payload: label, headers })}\n`,
      }),
      undefined
    ).then(response => response.text());
  expect([
    await viaCodec.catch((e: Error) => e.message),
    await forged([]),
    await forged([['x-agentgraph-user', 'local']]),
  ]).toEqual([
    expect.stringContaining('log in first'),
    expect.stringContaining('log in first'),
    expect.stringContaining('log in first'),
  ]);
});

it('keeps engine writes to the local CLI and lets a studio user say and label', async () => {
  const { data } = await makeInstance();
  const handle = makeActionWebHandler(makeInstanceHost({ data }));
  const asStudio = <A>(use: Parameters<typeof runActions<A, unknown>>[2]) =>
    Effect.runPromise(
      runActions('http://local/', (input, init) => handle(new Request(input, init), 'morgan'), use)
    ).catch((e: Error) => e.message);
  expect([
    await asStudio(client => client.instruct({ kind: 'resume', parked: true })),
    await asStudio(client => client.review({ issue: 1, verdict: 'approved', text: '' })),
    await asStudio(client => client.merge({ issue: 1 })),
    await asStudio(client => client.export({ issue: 1 })),
    await asStudio(client => client.close({ issue: 1 })),
    await asStudio(client => client.prune({ apply: true })),
    await asStudio(client => client.label({ id: 'r1', patch: { arm: 'x' } })),
  ]).toEqual([
    'instruct runs only from the agi CLI',
    'review runs only from the agi CLI',
    'merge runs only from the agi CLI',
    'export runs only from the agi CLI',
    'close runs only from the agi CLI',
    'prune runs only from the agi CLI',
    { arm: 'x' },
  ]);
});

it('watches runs, sending a list only when it changed', async () => {
  const { data } = await makeInstance();
  const record = join(data, 'r1', 'run.json');
  writeFileSync(record, readFileSync(record, 'utf8').replace('"id":"r1"', '"id":"r1","issue":1'));
  const seen = await callLocal(makeInstanceHost({ data }), client =>
    client.watch({}).pipe(
      Stream.tap(() =>
        Effect.sync(() =>
          writeFileSync(record, readFileSync(record, 'utf8').replace('"status":"done"', '"status":"running"'))
        )
      ),
      Stream.take(2),
      Stream.runCollect
    )
  );
  expect(seen.map(runs => runs.map(run => run.status))).toEqual([['done'], ['running']]);
});
