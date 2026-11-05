import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { tick } from '../src/run/trigger.ts';
import { Store } from '../src/store.ts';
import { Tracker } from '../src/tracker.ts';
import { begin } from '../src/workflow.ts';
import { reply, start, wrote } from './fixtures.ts';
import { git, issuePath } from './kit.ts';
import { world, push, pull, services, pullRequest } from './world.ts';
import { small, issue } from './tick-fixtures.ts';

const fresh = { ...push, branch: 'agentgraph/7-2' };
const reopened = { ...pull, branch: 'agentgraph/7-2' };

describe('restart after a closed pull request', () => {
  it('starts a new branch from the base, keeps the old branch and pull request, and links them', async () => {
    const where = world();
    git(join(where.root, 'seed'), 'push', '-q', where.origin, 'main:agentgraph/7');
    const old = git(where.origin, 'rev-parse', 'agentgraph/7');
    pullRequest(where);
    const path = issuePath(where.tracker, 8);
    writeFileSync(path, readFileSync(path, 'utf8').replace('state: open', 'state: closed'));
    const first = {
      ...begin(issue, { id: 'run-7', issue: 7, started: '2026-10-16T00:00:01.000Z' }),
      status: 'done' as const,
      checkout: { base: 'main', branch: 'agentgraph/7' },
    };
    const { specs, run } = services(where, [[start('b'), wrote('hello.txt', 'hi\n'), reply(fresh, reopened)]]);
    await run(Effect.flatMap(Store, s => s.put(first)));
    where.human('/agent:restart', '2026-10-17T00:00:00.000Z');

    const [second] = await run(tick(small));

    const runs = await run(Effect.flatMap(Store, s => s.list({ issue: 7 })));
    const pulls = await run(Effect.flatMap(Tracker, t => t.issues({})));
    expect(runs.map(r => [r.id, r.checkout?.branch]).toSorted()).toEqual([
      [second!.id, 'agentgraph/7-2'],
      ['run-7', 'agentgraph/7'],
    ]);
    expect(second!.status).toBe('done');
    expect(git(where.origin, 'rev-parse', 'agentgraph/7')).toBe(old);
    expect(git(where.origin, 'show', 'agentgraph/7-2:hello.txt')).toBe('hi');
    expect(git(where.origin, 'rev-parse', 'agentgraph/7-2^')).toBe(git(where.origin, 'rev-parse', 'main'));
    expect(pulls.filter(t => t.pull).map(t => [t.number, t.state, t.pull!.branch, t.body])).toEqual([
      [8, 'closed', 'agentgraph/7', 'Closes #7'],
      [9, 'open', 'agentgraph/7-2', 'Closes #7\n\nReplaces #8'],
    ]);
    expect(specs[0]!.prompt).toContain('Pull request #8 from agentgraph/7 was closed without merging');
    expect(specs[0]!.prompt).toContain('Work on the branch agentgraph/7-2');
  });
});
