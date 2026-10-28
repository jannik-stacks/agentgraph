import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { fileForge, Forge, writeIssueFile } from '../src/forge.ts';
import { tmp } from './kit.ts';

describe('file forge issue search', () => {
  it('matches title and body keywords, filters states, excludes pulls and limits results', async () => {
    const dir = tmp('forge-search');
    await writeIssueFile(dir, { title: 'Cache failure', author: 'alice', labels: [] }, 'retry');
    await writeIssueFile(dir, { title: 'Cache failure', author: 'alice', labels: [], state: 'closed' }, 'retry');
    await writeIssueFile(dir, { title: 'Cache', author: 'alice', labels: [] }, 'failure retry');
    await writeIssueFile(dir, { title: 'Other issue', author: 'alice', labels: [] }, 'retry');
    await writeIssueFile(dir, { title: 'Cache failure', author: 'alice', labels: [] }, 'retry');
    await mkdir(join(dir, '5'));
    await writeFile(
      join(dir, '5', 'pull.json'),
      JSON.stringify({ branch: 'agentgraph/5', base: 'main', head: 'head' })
    );
    const found = await Effect.runPromise(
      Effect.gen(function* () {
        const forge = yield* Forge;
        return yield* Effect.all([
          forge.searchIssues('CACHE AND failure repo:elsewhere/repo'),
          forge.searchIssues('cache failure', { state: 'closed' }),
          forge.searchIssues('cache failure', { state: 'all' }),
          forge.searchIssues('cache failure', { state: 'all', limit: 1 }),
        ]);
      }).pipe(Effect.provide(fileForge(dir)))
    );
    expect(found.map(issues => issues.map(issue => issue.number))).toEqual([[1, 3], [2], [1, 2, 3], [1]]);
  });

  it('withholds matching outsider text before returning results', async () => {
    const dir = tmp('forge-search-trust');
    await writeIssueFile(dir, { title: 'Cache failure', author: 'outsider', labels: [] }, 'untrusted instructions');
    const found = await Effect.runPromise(
      Effect.flatMap(Forge, forge => forge.searchIssues('cache')).pipe(
        Effect.provide(fileForge(dir, undefined, ['alice']))
      )
    );
    expect(found.map(issue => [issue.title, issue.body])).toEqual([
      ['(title by @outsider withheld: not a collaborator)', '(issue text by @outsider withheld: not a collaborator)'],
    ]);
  });

  it.each([0, 101, 1.5, NaN])('rejects an invalid search limit: %s', async limit => {
    const found = await Effect.runPromise(
      Effect.flatMap(Forge, forge => forge.searchIssues('cache', { limit })).pipe(
        Effect.either,
        Effect.provide(fileForge(tmp('forge-search-limit')))
      )
    );
    expect(found._tag).toBe('Left');
  });
});
