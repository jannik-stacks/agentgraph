import { existsSync, mkdirSync, readFileSync, symlinkSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { removeBranch } from '../src/disk.ts';
import { Store } from '../src/store.ts';
import { Tracker } from '../src/tracker.ts';
import { scanIssuesAndRunningRuns, tick } from '../src/run/trigger.ts';
import { commit, git, issuePath, write, writeIssueAt } from './kit.ts';
import { fresh, graph, say, services, world } from './world.ts';

const setup = () => {
  const where = world();
  const path = join(where.root, 'checkout');
  git(where.origin, 'worktree', 'add', '-b', 'agentgraph/7', path, 'main');
  write(path, { '.gitignore': 'node_modules\ntarget/\n' });
  const head = commit(path, { 'landed.txt': 'landed' });
  git(where.origin, 'update-ref', 'refs/agentgraph/attempts/run-7/1', head, '');
  git(where.origin, 'update-ref', 'refs/agentgraph/runs/run-7', head, '');
  const clean = (merged = true) =>
    Effect.runPromise(removeBranch(where.origin, 'agentgraph/7', 'main', merged ? head : undefined));
  return { ...where, path, head, clean };
};

describe('landed checkout cleanup', () => {
  it('removes a merged checkout and branch, preserving data, attempt refs and symlink targets', async () => {
    const run = setup();
    writeIssueAt(
      issuePath(run.tracker, 7),
      readFileSync(issuePath(run.tracker, 7), 'utf8').replace('state: open', 'state: closed')
    );
    const engine = services(run, []);
    await engine.run(Effect.flatMap(Store, s => s.put({ ...fresh(), status: 'done' })));
    write(run.data, { 'run-7/result.json': 'result', 'run-7/events.jsonl': 'events', 'run-7/logs/output': 'log' });
    const record = readFileSync(join(run.data, 'run-7/run.json'), 'utf8');
    const trace = readFileSync(join(run.data, 'run-7/trace.jsonl'), 'utf8');
    const shared = join(run.root, 'shared');
    write(shared, { 'dependency.js': 'shared' });
    symlinkSync(shared, join(run.path, 'node_modules'));
    mkdirSync(join(run.path, 'target'));
    write(run.path, { 'target/build': 'generated' });
    writeIssueAt(
      issuePath(run.tracker, 8),
      `---\ntitle: Landed\nstate: merged\nauthor: morgan\nlabels: []\n---\n\nCloses #7\n`
    );
    write(run.tracker, { '8/pull.json': JSON.stringify({ branch: 'agentgraph/7', base: 'main', head: run.head }) });
    say(run, { issue: 8, kind: 'merged', actor: 'morgan', trusted: true, at: '2026-10-16T00:01:00.000Z' });
    await engine.run(scanIssuesAndRunningRuns(graph));
    expect(existsSync(run.path)).toBe(false);
    expect(git(run.origin, 'branch', '--list', 'agentgraph/7')).toBe('');
    expect(git(run.origin, 'rev-parse', 'refs/agentgraph/attempts/run-7/1')).toBe(run.head);
    expect(git(run.origin, 'rev-parse', 'refs/agentgraph/runs/run-7')).toBe(run.head);
    expect(readFileSync(join(run.data, 'run-7/run.json'), 'utf8')).toBe(record);
    expect(readFileSync(join(run.data, 'run-7/trace.jsonl'), 'utf8')).toBe(trace);
    expect(readFileSync(join(run.data, 'run-7/result.json'), 'utf8')).toBe('result');
    expect(readFileSync(join(run.data, 'run-7/events.jsonl'), 'utf8')).toBe('events');
    expect(readFileSync(join(run.data, 'run-7/logs/output'), 'utf8')).toBe('log');
    expect(readFileSync(join(shared, 'dependency.js'), 'utf8')).toBe('shared');
    await run.clean();
  });

  it('does not fetch issues for a done run whose local branch is gone', async () => {
    const run = setup();
    await run.clean();
    writeIssueAt(
      issuePath(run.tracker, 7),
      readFileSync(issuePath(run.tracker, 7), 'utf8').replace('state: open', 'state: closed')
    );
    writeIssueAt(issuePath(run.tracker, 8), '---\ntitle: Landed\nstate: merged\nauthor: morgan\nlabels: []\n---\n');
    write(run.tracker, { '8/pull.json': JSON.stringify({ branch: 'agentgraph/7', base: 'main', head: run.head }) });
    say(run, { issue: 8, kind: 'merged', actor: 'morgan', trusted: true, at: '2026-10-16T00:01:00.000Z' });
    const engine = services(run, []);
    await engine.run(Effect.flatMap(Store, s => s.put({ ...fresh(), status: 'done' })));
    const fetched: number[] = [];
    await engine.run(
      Effect.updateService(scanIssuesAndRunningRuns(graph), Tracker, tracker => ({
        ...tracker,
        issue: n => {
          fetched.push(n);
          return tracker.issue(n);
        },
      }))
    );
    expect(fetched).toEqual([]);
  });

  it('keeps a checkout reached through a symlink', async () => {
    const run = setup();
    const target = join(run.root, 'moved');
    renameSync(run.path, target);
    symlinkSync(target, run.path);
    await run.clean();
    expect(readFileSync(join(target, 'landed.txt'), 'utf8')).toBe('landed');
    expect(git(run.origin, 'rev-parse', 'agentgraph/7')).toBe(run.head);
  });

  it('keeps a checkout reached through a symlinked parent', async () => {
    const run = setup();
    const parent = join(run.root, 'parent');
    mkdirSync(parent);
    const path = join(parent, 'checkout');
    git(run.origin, 'worktree', 'move', run.path, path);
    const shared = join(run.root, 'shared-parent');
    renameSync(parent, shared);
    symlinkSync(shared, parent);
    await run.clean();
    expect(readFileSync(join(shared, 'checkout/landed.txt'), 'utf8')).toBe('landed');
    expect(git(run.origin, 'rev-parse', 'agentgraph/7')).toBe(run.head);
  });

  it('keeps a landed branch another live workflow uses', async () => {
    const run = setup();
    const engine = services(run, []);
    await engine.run(
      Effect.flatMap(Store, s =>
        Effect.andThen(
          s.put({ ...fresh(), status: 'done' }),
          s.put({ ...fresh(), id: 'other-9', issue: 9, workflow: 'other', status: 'waiting' })
        )
      )
    );
    git(run.origin, 'update-ref', 'refs/heads/main', run.head, git(run.origin, 'rev-parse', 'main'));
    const shared = {
      ...graph,
      workflows: { ...graph.workflows, other: { ...graph.workflows.issue!, name: 'other', branch: 'agentgraph/7' } },
    };
    await engine.run(tick(shared, 7, true));
    expect(existsSync(run.path)).toBe(true);
    expect(git(run.origin, 'rev-parse', 'agentgraph/7')).toBe(run.head);
    await engine.run(
      Effect.flatMap(Store, s => s.put({ ...fresh(), id: 'other-9', issue: 9, workflow: 'other', status: 'done' }))
    );
    await engine.run(tick(shared, 7, true));
    expect(existsSync(run.path)).toBe(false);
    expect(git(run.origin, 'branch', '--list', 'agentgraph/7')).toBe('');
  });

  it('keeps an unmerged branch with unique commits', async () => {
    const run = setup();
    await run.clean(false);
    expect(existsSync(run.path)).toBe(true);
    expect(git(run.origin, 'rev-parse', 'agentgraph/7')).toBe(run.head);
  });

  it.each(['tracked', 'untracked', 'staged'])('keeps a %s dirty checkout', async kind => {
    const run = setup();
    write(run.path, { [kind === 'untracked' ? 'new.txt' : 'landed.txt']: 'unsaved' });
    if (kind === 'staged') git(run.path, 'add', '-A');
    await run.clean();
    expect(existsSync(run.path)).toBe(true);
    expect(git(run.origin, 'rev-parse', 'agentgraph/7')).toBe(run.head);
  });

  it('keeps local commits made after the merged PR head', async () => {
    const run = setup();
    const unpublished = commit(run.path, { 'extra.txt': 'unpublished' });
    await run.clean();
    expect(existsSync(run.path)).toBe(true);
    expect(git(run.origin, 'rev-parse', 'agentgraph/7')).toBe(unpublished);
  });

  it('removes work already on the base without a merged PR', async () => {
    const run = setup();
    git(run.origin, 'update-ref', 'refs/heads/main', run.head, git(run.origin, 'rev-parse', 'main'));
    await run.clean(false);
    expect(existsSync(run.path)).toBe(false);
    expect(git(run.origin, 'branch', '--list', 'agentgraph/7')).toBe('');
  });

  it('prunes a missing checkout and removes its landed branch', async () => {
    const run = setup();
    rmSync(run.path, { recursive: true });
    await run.clean();
    expect(git(run.origin, 'branch', '--list', 'agentgraph/7')).toBe('');
    expect(git(run.origin, 'worktree', 'list', '--porcelain')).not.toContain(run.path);
  });
});
