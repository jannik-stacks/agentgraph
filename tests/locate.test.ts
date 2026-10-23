import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { fileStore, locate, Store } from '../src/store.ts';
import type { Trace } from '../src/trace.ts';
import type { Run } from '../src/workflow.ts';
import { tmp } from './kit.ts';

const pr = 'https://github.com/o/r/pull/23';
const run = (id: string, issue: number) =>
  ({ id, issue, workflow: 'issue', step: 'review', status: 'done', started: '2026-10-16T00:00:00.000Z' }) as Run;
const trace: Trace[] = [
  {
    at: '2026-10-19T15:40:00.000Z',
    step: 'implement',
    applied: {
      proposal: { kind: 'pull_request', branch: 'b', base: 'main', title: 't', body: 'b' },
      ok: true,
      url: pr,
    },
  },
  {
    at: '2026-10-19T15:43:05.403Z',
    step: 'review',
    applied: {
      proposal: { kind: 'comment', body: 'Looks right.', under: '1' },
      ok: true,
      url: `${pr}#discussion_r4315833405`,
      id: '4315833405',
    },
  },
  {
    at: '2026-10-19T15:50:00.000Z',
    step: 'review',
    applied: {
      proposal: { kind: 'comment', body: 'Status.', edit: '62' },
      ok: true,
      url: 'https://github.com/o/r/issues/2#issuecomment-62',
      id: '62',
      at: '2026-10-19T15:49:59.000Z',
    },
  },
  { at: '2026-10-19T15:51:00.000Z', step: 'review', applied: { proposal: { kind: 'react' }, ok: true, id: '99' } },
];

const find = (gh: string) => {
  const dir = tmp('locate');
  return Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.put(run('issue-2-1', 2));
      yield* store.trace('issue-2-1', ...trace);
      return yield* Effect.either(locate({ gh }));
    }).pipe(Effect.provide(fileStore(dir)))
  );
};

describe('locate', () => {
  it('finds the run write a comment link or id names, at the time its body was stamped when it was', async () => {
    const review = { run: 'issue-2-1', step: 'review', at: '2026-10-19T15:43:05.403Z' };
    expect(await find(`${pr}#discussion_r4315833405`)).toMatchObject({ right: review });
    expect(await find(`${pr}/files#r4315833405`)).toMatchObject({ right: review });
    expect(await find(' 4315833405 ')).toMatchObject({ right: review });
    expect(await find('https://github.com/o/r/issues/2#issuecomment-62')).toMatchObject({
      right: { run: 'issue-2-1', step: 'review', at: '2026-10-19T15:49:59.000Z' },
    });
  });

  it('names the issue for a pull request or issue link, or a comment no run wrote', async () => {
    expect(await find(pr)).toMatchObject({ right: { issue: 2 } });
    expect(await find('https://github.com/o/r/issues/5')).toMatchObject({ right: { issue: 5 } });
    expect(await find('https://github.com/o/r/issues/5#issuecomment-1')).toMatchObject({ right: { issue: 5 } });
  });

  it('finds nothing for an id no comment has, and refuses an empty query', async () => {
    expect(await find('99')).toMatchObject({ right: undefined });
    expect(await find('  ')).toMatchObject({ _tag: 'Left', left: { _tag: 'ParseError' } });
  });
});
