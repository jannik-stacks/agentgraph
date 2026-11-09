import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Stream } from 'effect';
import { afterEach, expect, it } from 'vitest';
import { makeInstanceHost } from '../src/engine.ts';
import { folderTracker, writeIssueFile } from '../src/tracker.ts';

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
    JSON.stringify({ id: 'r1', workflow: 'issue', step: 'build', status: 'done', started: '2026-11-01T00:00:00Z' })
  );
  const issue = await writeIssueFile(tracker, { title: 'Trend', author: 'morgan', labels: [] }, 'body');
  return { data, tracker, issue };
};

it('reads runs, labels and tracker issues of its one instance and acts through the CLI functions', async () => {
  const { data, tracker, issue } = await makeInstance();
  const host = makeInstanceHost(
    { data },
    {
      layer: folderTracker(tracker, 'morgan', ['morgan']),
      origin: { origin: join(tracker, 'origin.git'), local: true },
    }
  );
  const read = await Effect.runPromise(
    Effect.all({
      records: host.store.listRecords(),
      issues: host.tracker.issues({ state: 'open' }),
      labels: host.actions.label.run('r1', { arm: 'base' }),
      said: host.actions.say.run(issue, 'go on'),
    })
  );
  const events = await Effect.runPromise(Stream.runCollect(host.tracker.since('')));
  expect({
    records: read.records.map(run => run.id),
    issues: read.issues.map(i => i.title),
    labels: read.labels,
    said: read.said.ok,
    runs: host.readRuns().map(run => run.labels),
    comments: events.flatMap(event => (event.comment ? [event.comment.body] : [])),
  }).toEqual({
    records: ['r1'],
    issues: ['Trend'],
    labels: { arm: 'base' },
    said: true,
    runs: [{ arm: 'base' }],
    comments: ['/agent go on'],
  });
});

it.each([
  [
    'labels a missing run',
    (host: ReturnType<typeof makeInstanceHost>) => host.actions.label.run('r9', { arm: 'x' }),
    'no run r9',
  ],
  [
    'reads without a tracker',
    (host: ReturnType<typeof makeInstanceHost>) => host.tracker.issues(),
    'serves no tracker',
  ],
  [
    'says without a tracker',
    (host: ReturnType<typeof makeInstanceHost>) => host.actions.say.run(1, 'hi'),
    'serves no tracker',
  ],
])('refuses when it %s', async (_name, act, error) => {
  const { data } = await makeInstance();
  await expect(Effect.runPromise(act(makeInstanceHost({ data })) as Effect.Effect<unknown, unknown>)).rejects.toThrow(
    error
  );
});

it('posts nothing on a tracker that is not local, as agi say', async () => {
  const { data, tracker, issue } = await makeInstance();
  const host = makeInstanceHost(
    { data },
    { layer: folderTracker(tracker), origin: { origin: 'https://github.com/o/r' } }
  );
  await expect(Effect.runPromise(host.actions.say.run(issue, 'hi'))).rejects.toThrow('this host does not post there');
});
