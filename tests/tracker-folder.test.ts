import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { folderTracker, Tracker, waitForTrackerEdit, writeIssueFile } from '../src/tracker.ts';
import { waitForLock } from '../src/owner.ts';
import { tmp } from './kit.ts';

const readOpenNumbers = (dir: string) =>
  Effect.runPromise(
    Effect.flatMap(Tracker, tracker => tracker.issues({ state: 'open' })).pipe(Effect.provide(folderTracker(dir)))
  ).then(issues => issues.map(issue => issue.number));

const settle = (wait: Promise<void>) =>
  Promise.race([
    wait.then(
      () => 'woke',
      () => 'aborted'
    ),
    sleep(1000).then(() => 'asleep'),
  ]);

describe('folder tracker', () => {
  it('ignores a numbered folder without issue.md even when its pull.json cannot be read', async () => {
    const dir = tmp('tracker-orphan');
    await writeIssueFile(dir, { title: 'Real', author: 'alice', labels: [] }, 'body');
    mkdirSync(join(dir, '2', 'pull.json'), { recursive: true });
    expect(await readOpenNumbers(dir)).toEqual([1]);
  });
});

describe('waitForTrackerEdit', () => {
  it('sleeps through lock files and wakes on an issue edit after them', async () => {
    const dir = tmp('tracker-watch');
    const stop = new AbortController();
    const wait = waitForTrackerEdit(dir, stop.signal);
    await sleep(200);
    const release = await waitForLock('.tracker', dir);
    await release();
    const afterLocks = await settle(wait);
    writeFileSync(join(dir, 'edit.md'), 'changed');
    const afterEdit = await settle(wait);
    stop.abort();
    expect([afterLocks, afterEdit]).toEqual(['asleep', 'woke']);
  });

  it('ends on abort while only lock files change', async () => {
    const dir = tmp('tracker-watch-abort');
    const stop = new AbortController();
    const wait = waitForTrackerEdit(dir, stop.signal);
    await sleep(200);
    const release = await waitForLock('.tracker', dir);
    await release();
    await sleep(300);
    stop.abort();
    expect(await settle(wait)).toBe('aborted');
  });
});
