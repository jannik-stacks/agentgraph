import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Stream } from 'effect';
import { afterEach, expect, it } from 'vitest';
import { makeActionClient } from '../src/actions.ts';
import { makeActionWebHandler, makeInstanceHost, makeLocalActionClient } from '../src/engine.ts';
import { folderTracker, writeIssueFile } from '../src/tracker.ts';
import { stoppedByRunner } from '../src/context.ts';
import { instruct } from '../src/run/trigger.ts';
import { Store } from '../src/store.ts';
import { begin } from '../src/workflow.ts';
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

const callLocal = <A, E>(
  host: ReturnType<typeof makeInstanceHost>,
  call: (client: LocalClient) => Effect.Effect<A, E>
) => Effect.runPromise(Effect.scoped(Effect.flatMap(makeLocalActionClient(host), call)));
type LocalClient = Effect.Success<ReturnType<typeof makeLocalActionClient>>;

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
  ['resumes without a drive', (client: LocalClient) => client.resume({ parked: true }), 'does not drive runs'],
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
        reason: `${stoppedByRunner} (SessionStop).`,
        retried: true,
      })
    )
  );
  const host = makeInstanceHost({ data: where.data }, undefined, instruction => run(instruct(graph, instruction)));
  const resumed = await callLocal(host, client => client.resume({ parked: true }));
  expect(resumed.map(r => [r.id, r.status, r.retried])).toEqual([['retro-7', 'running', undefined]]);
});

it('refuses a call that carries no user, even through the same codec', async () => {
  const { data } = await makeInstance();
  const { handler } = makeActionWebHandler(makeInstanceHost({ data }));
  await expect(
    Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(
          makeActionClient('http://local/', (input, init) => handler(new Request(input, init))),
          client => client.label({ id: 'r1', patch: { arm: 'x' } })
        )
      )
    )
  ).rejects.toThrow('log in first');
});
