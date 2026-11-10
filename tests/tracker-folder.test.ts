import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { findBranchPull, folderTracker, Tracker, waitForTrackerEdit, writeIssueFile } from '../src/tracker.ts';
import type { Issue } from '../src/event.ts';
import { isTemplateBranch } from '../src/workflow.ts';
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

  it('reads what an issue stacks on and depends on from its frontmatter and its body lines', async () => {
    const dir = tmp('tracker-links');
    await writeIssueFile(
      dir,
      { title: 'Bye', author: 'alice', labels: [], dependsOn: [5] },
      'Add bye.\n\nStacks on #3\nDepends on #4'
    );
    const [issue] = await Effect.runPromise(
      Effect.flatMap(Tracker, tracker => tracker.issues({ state: 'open' })).pipe(Effect.provide(folderTracker(dir)))
    );
    expect([issue?.stacksOn, issue?.dependsOn]).toEqual([3, [5, 4]]);
  });

  it('turns label edits in the frontmatter into events by the author, a removal into an unlabel, and adopts an old timeline quietly', async () => {
    const dir = tmp('tracker-label-sync');
    await writeIssueFile(dir, { title: 'Grow', author: 'alice', labels: ['agent:ready'] }, 'body');
    const events = (...work: ((t: Tracker['Service']) => Effect.Effect<unknown, unknown>)[]) =>
      Effect.runPromise(
        Effect.flatMap(Tracker, t =>
          Effect.andThen(
            Effect.forEach(work, f => f(t)),
            t.issue(1)
          )
        ).pipe(Effect.provide(folderTracker(dir)))
      ).then(i => i.events.map(m => [m.kind, m.label, m.actor, m.trusted]));
    const adopted = ['label', 'agent:ready', 'alice', true];
    expect(await events()).toEqual([adopted]);
    const file = join(dir, '1', 'issue.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace('- agent:ready', '- agent:usd-per-run:20'));
    const edited = [
      adopted,
      ['unlabel', 'agent:ready', 'alice', true],
      ['label', 'agent:usd-per-run:20', 'alice', true],
    ];
    expect(await events()).toEqual(edited);
    expect(await events(t => t.apply(1, { kind: 'label', remove: ['agent:usd-per-run:20'] }))).toEqual([
      ...edited,
      ['unlabel', 'agent:usd-per-run:20', 'agentgraph[bot]', false],
    ]);
    expect(await events()).toHaveLength(4);
    writeFileSync(join(dir, '1', 'events.jsonl'), '');
    rmSync(join(dir, '1', 'labels.json'));
    writeFileSync(file, readFileSync(file, 'utf8').replace('labels: []', 'labels: [agent:ready]'));
    expect([await events(), readFileSync(file, 'utf8')]).toEqual([[], expect.stringContaining('agent:ready')]);
  });
});

describe('branch pulls', () => {
  const pull = (number: number, state: Issue['state'], branch = 'agentgraph/7'): Issue => ({
    number,
    title: '',
    body: '',
    state,
    labels: [],
    author: 'alice',
    pull: { branch, base: 'main', head: `h${number}` },
    url: '',
  });

  it.each([
    [[pull(8, 'closed'), pull(9, 'open'), pull(10, 'closed')], 9],
    [[pull(8, 'merged'), pull(10, 'closed')], 10],
    [[pull(8, 'open', 'agentgraph/7-2')], undefined],
  ])('picks an open pull request on the branch over a closed one, then the newest', (issues, expected) => {
    expect(findBranchPull(issues, 'agentgraph/7')?.number).toBe(expected);
  });

  it.each([
    ['agentgraph/{issue}', 'agentgraph/12', 12, true],
    ['agentgraph/{issue}', 'agentgraph/12-2', 12, true],
    ['agentgraph/{issue}', 'agentgraph/12-2', 2, false],
    ['agentgraph/{parent}/{issue}', 'agentgraph/1/2', undefined, true],
    ['agentgraph/{parent}/{issue}', 'agentgraph/1/2/3', 3, true],
    ['fix-{number}', 'fix-1', undefined, true],
    ['agent.{issue}', 'agentx12', undefined, false],
  ])('matches %s against %s for issue %s', (template, branch, issue, expected) => {
    expect(isTemplateBranch(template, branch, issue)).toBe(expected);
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
