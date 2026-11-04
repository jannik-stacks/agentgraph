import { Effect, Redacted } from 'effect';
import { describe, expect, it } from 'vitest';
import { Tracker } from '../src/tracker.ts';
import { githubTracker } from '../src/github.ts';
import { reply, start } from './fixtures.ts';
import { git } from './kit.ts';
import { fresh, graph, services, w, world } from './world.ts';
import { runWorkflow } from '../src/run/drive.ts';

describe('workflow base', () => {
  it('starts from the repository default branch even when a tag shares its name', async () => {
    const where = world();
    git(where.origin, 'branch', '-m', 'main', 'develop');
    git(where.origin, 'tag', 'develop');
    const workflow = {
      ...w,
      steps: [{ name: 'implement', does: { agent: 'implementor' }, tries: 1, checks: [] }],
      checks: [],
    };
    const { run, specs } = services(where, [[start('a'), reply({ kind: 'ask', question: 'Ready?' })]]);
    const stored = await run(runWorkflow(workflow, { ...fresh(), step: 'implement' }, graph));
    expect(stored.status).toBe('waiting');
    expect(specs).toHaveLength(1);
    expect(specs[0]!.prompt).toContain('pull requests go into develop.');
    expect(stored.startCommit).toBe(git(where.origin, 'rev-parse', 'develop'));
  });

  it('reads the default branch from GitHub repository metadata', async () => {
    const paths: string[] = [];
    const tracker = githubTracker(
      { repo: 'owner/repository', id: '1', key: Redacted.make('unused') },
      async url => {
        paths.push(String(url));
        return new Response(JSON.stringify({ default_branch: 'develop' }));
      },
      () => Effect.succeed('token')
    );
    const base = await Effect.runPromise(Effect.flatMap(Tracker, f => f.base).pipe(Effect.provide(tracker)));
    expect(base).toBe('develop');
    expect(paths).toEqual(['https://api.github.com/repos/owner/repository']);
  });
});
