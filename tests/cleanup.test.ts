import { existsSync, mkdirSync, readFileSync, symlinkSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Logger } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { removeBranch } from '../src/disk.ts';
import * as host from '../src/git.ts';
import { Store } from '../src/store.ts';
import { Tracker } from '../src/tracker.ts';
import { runWorkflow } from '../src/run/drive.ts';
import { scanIssuesAndRunningRuns } from '../src/run/trigger.ts';
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
  return { ...where, path, head, clean, checkout: { branch: 'agentgraph/7', base: 'main' } };
};

const cleanOldRun = async (exact: boolean) => {
  const run = setup();
  const head = exact
    ? run.head
    : git(
        run.origin,
        'commit-tree',
        git(run.origin, 'rev-parse', `${run.head}^{tree}`),
        '-p',
        run.head,
        '-m',
        'Merged descendant'
      );
  writeIssueAt(issuePath(run.tracker, 7), '---\ntitle: Done\nstate: closed\nauthor: morgan\nlabels: []\n---\n');
  writeIssueAt(issuePath(run.tracker, 8), '---\ntitle: Landed\nstate: merged\nauthor: morgan\nlabels: []\n---\n');
  write(run.tracker, { '8/pull.json': JSON.stringify({ branch: 'agentgraph/7', base: 'main', head }) });
  const engine = services(run, []);
  await engine.run(Effect.flatMap(Store, s => s.put({ ...fresh(), status: 'done' })));
  await engine.run(scanIssuesAndRunningRuns(graph));
  return run;
};

describe('landed checkout cleanup', () => {
  it('removes a merged checkout and branch, preserving data, attempt refs and symlink targets', async () => {
    const run = setup();
    writeIssueAt(
      issuePath(run.tracker, 7),
      readFileSync(issuePath(run.tracker, 7), 'utf8').replace('state: open', 'state: closed')
    );
    const engine = services(run, []);
    await engine.run(Effect.flatMap(Store, s => s.put({ ...fresh(), checkout: run.checkout, status: 'done' })));
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

  it('cleans an idle repository with only ended runs and their merged PR, looking up each branch once', async () => {
    const run = setup();
    writeIssueAt(issuePath(run.tracker, 7), '---\ntitle: Done\nstate: closed\nauthor: morgan\nlabels: []\n---\n');
    writeIssueAt(issuePath(run.tracker, 8), '---\ntitle: Landed\nstate: merged\nauthor: morgan\nlabels: []\n---\n');
    write(run.tracker, { '8/pull.json': JSON.stringify({ branch: 'agentgraph/7', base: 'main', head: run.head }) });
    const engine = services(run, []);
    await engine.run(
      Effect.flatMap(Store, s =>
        Effect.andThen(
          s.put({ ...fresh(), checkout: run.checkout, status: 'done' }),
          s.put({ ...fresh(), checkout: run.checkout, id: 'older-7', status: 'done' })
        )
      )
    );
    const branches: string[] = [];
    await engine.run(
      Effect.updateService(
        Effect.andThen(scanIssuesAndRunningRuns(graph), scanIssuesAndRunningRuns(graph)),
        Tracker,
        tracker => ({
          ...tracker,
          issues: filter => {
            if (filter?.branch) branches.push(filter.branch);
            return tracker.issues(filter);
          },
        })
      )
    );
    expect(branches).toEqual(['agentgraph/7']);
    expect(existsSync(run.path)).toBe(false);
    expect(git(run.origin, 'branch', '--list', 'agentgraph/7')).toBe('');
  });

  it('cleans landed work while an unrelated run waits without checkout metadata', async () => {
    const run = setup();
    git(run.origin, 'update-ref', 'refs/heads/main', run.head, git(run.origin, 'rev-parse', 'main'));
    writeIssueAt(issuePath(run.tracker, 7), '---\ntitle: Done\nstate: closed\nauthor: morgan\nlabels: []\n---\n');
    writeIssueAt(issuePath(run.tracker, 9), '---\ntitle: Waiting\nstate: closed\nauthor: morgan\nlabels: []\n---\n');
    const engine = services(run, []);
    await engine.run(
      Effect.flatMap(Store, s =>
        Effect.andThen(
          s.put({ ...fresh(), checkout: run.checkout, status: 'done' }),
          s.put({ ...fresh(), id: 'waiting-9', issue: 9, status: 'waiting' })
        )
      )
    );
    await engine.run(scanIssuesAndRunningRuns(graph));
    expect(existsSync(run.path)).toBe(false);
    expect(git(run.origin, 'branch', '--list', 'agentgraph/7')).toBe('');
    expect((await engine.run(Effect.flatMap(Store, s => s.get('waiting-9'))))?.status).toBe('waiting');
  });

  it.each(['directory', 'symlink'])(
    'still removes ignored build output and %s node_modules without following symlinks',
    async kind => {
      const run = setup();
      const head = commit(run.path, { '.gitignore': 'node_modules/\nbuild/\n' });
      write(run.path, { 'build/output': 'generated' });
      const shared = join(run.root, 'shared');
      write(shared, { 'dependency.js': 'keep' });
      if (kind === 'symlink') symlinkSync(shared, join(run.path, 'node_modules'));
      else write(run.path, { 'node_modules/dependency.js': 'local dependency' });
      await Effect.runPromise(removeBranch(run.origin, 'agentgraph/7', 'main', head));
      expect(existsSync(run.path)).toBe(false);
      expect(git(run.origin, 'branch', '--list', 'agentgraph/7')).toBe('');
      expect(readFileSync(join(shared, 'dependency.js'), 'utf8')).toBe('keep');
    }
  );

  it.each(['--assume-unchanged', '--skip-worktree'])('keeps hidden edits marked %s', async flag => {
    const run = setup();
    git(run.path, 'update-index', flag, 'landed.txt');
    write(run.path, { 'landed.txt': 'hidden edit' });
    await run.clean();
    expect(readFileSync(join(run.path, 'landed.txt'), 'utf8')).toBe('hidden edit');
    expect(git(run.origin, 'rev-parse', 'agentgraph/7')).toBe(run.head);
  });

  it('lets Git refuse an edit made after inspection and logs a skip', async () => {
    const run = setup();
    const original = host.hostGit;
    const spy = vi.spyOn(host, 'hostGit').mockImplementation((env, args, options) => {
      if (args.includes('remove')) write(run.path, { 'landed.txt': 'late edit' });
      return original(env, args, options);
    });
    const messages: { level: string; text: string }[] = [];
    try {
      await Effect.runPromise(
        removeBranch(run.origin, 'agentgraph/7', 'main', run.head).pipe(
          Effect.provide(
            Logger.layer([
              Logger.make(({ logLevel, message }) => messages.push({ level: logLevel, text: String(message) })),
            ])
          )
        )
      );
    } finally {
      spy.mockRestore();
    }
    expect(readFileSync(join(run.path, 'landed.txt'), 'utf8')).toBe('late edit');
    expect(git(run.origin, 'rev-parse', 'agentgraph/7')).toBe(run.head);
    expect(messages.some(m => m.level === 'Warn' && m.text.includes('1 skipped removal'))).toBe(true);
    expect(messages.some(m => m.level === 'Error')).toBe(false);
  });

  it('skips symbolic agent refs and preserves their main target', async () => {
    const run = world();
    const main = git(run.origin, 'rev-parse', 'main');
    git(run.origin, 'symbolic-ref', 'refs/heads/agentgraph/7', 'refs/heads/main');
    const messages: string[] = [];
    await Effect.runPromise(
      removeBranch(run.origin, 'agentgraph/7', 'main').pipe(
        Effect.provide(Logger.layer([Logger.make(({ message }) => messages.push(String(message)))]))
      )
    );
    expect(git(run.origin, 'rev-parse', 'main')).toBe(main);
    expect(git(run.origin, 'symbolic-ref', 'refs/heads/agentgraph/7')).toBe('refs/heads/main');
    expect(messages.some(m => m.includes('1 skipped cleanup') && m.includes('symbolic ref'))).toBe(true);
  });

  it('requires an exact merged PR head to clean old runs without checkout records', async () => {
    const exact = await cleanOldRun(true);
    const mismatch = await cleanOldRun(false);
    expect(existsSync(exact.path)).toBe(false);
    expect(git(exact.origin, 'branch', '--list', 'agentgraph/7')).toBe('');
    expect(existsSync(mismatch.path)).toBe(true);
    expect(git(mismatch.origin, 'rev-parse', 'agentgraph/7')).toBe(mismatch.head);
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
    await engine.run(Effect.flatMap(Store, s => s.put({ ...fresh(), checkout: run.checkout, status: 'done' })));
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
    git(run.path, 'branch', '-m', 'agentgraph/42');
    run.checkout.branch = 'agentgraph/42';
    writeIssueAt(
      issuePath(run.tracker, 7),
      '---\ntitle: Parent work\nstate: closed\nauthor: morgan\nlabels: []\nparent: 42\n---\n'
    );
    writeIssueAt(
      issuePath(run.tracker, 9),
      '---\ntitle: More parent work\nstate: closed\nauthor: morgan\nlabels: []\nparent: 42\n---\n'
    );
    const engine = services(run, []);
    await engine.run(
      Effect.flatMap(Store, s =>
        Effect.andThen(
          s.put({ ...fresh(), checkout: run.checkout, status: 'done' }),
          s.put({ ...fresh(), checkout: run.checkout, id: 'other-9', issue: 9, workflow: 'other', status: 'waiting' })
        )
      )
    );
    git(run.origin, 'update-ref', 'refs/heads/main', run.head, git(run.origin, 'rev-parse', 'main'));
    const shared = {
      ...graph,
      workflows: {
        ...graph.workflows,
        other: { ...graph.workflows.issue!, name: 'other', branch: 'agentgraph/{parent}' },
      },
    };
    await engine.run(scanIssuesAndRunningRuns(shared));
    expect(existsSync(run.path)).toBe(true);
    expect(git(run.origin, 'rev-parse', 'agentgraph/42')).toBe(run.head);
    await engine.run(
      Effect.flatMap(Store, s =>
        s.put({ ...fresh(), checkout: run.checkout, id: 'other-9', issue: 9, workflow: 'other', status: 'done' })
      )
    );
    await engine.run(scanIssuesAndRunningRuns(shared));
    expect(existsSync(run.path)).toBe(false);
    expect(git(run.origin, 'branch', '--list', 'agentgraph/42')).toBe('');
  });

  it.each([
    { branch: 'agentgraph/{parent}/{issue}', base: 'main', resolvedBranch: 'agentgraph/42/7', resolvedBase: 'main' },
    {
      branch: 'agentgraph/{issue}',
      base: 'release/{issue}',
      resolvedBranch: 'agentgraph/7',
      resolvedBase: 'release/7',
    },
  ])('cleans a closed run using recorded $branch and $base', async ({ branch, base, resolvedBranch, resolvedBase }) => {
    const run = world();
    git(run.origin, 'branch', 'release/7', 'main');
    writeIssueAt(
      issuePath(run.tracker, 7),
      '---\ntitle: Parent work\nstate: open\nauthor: morgan\nlabels: []\nparent: 42\n---\n'
    );
    const flow = {
      ...graph.workflows.issue!,
      branch,
      base,
      checks: [],
      steps: [{ name: 'work', does: { run: 'true', returns: [] }, checks: [], tries: 1 }],
    };
    const selected = { ...graph, workflows: { issue: flow } };
    const engine = services(run, []);
    const begun = { ...fresh(), step: 'work' };
    await engine.run(Effect.flatMap(Store, s => s.put(begun)));
    const ended = await engine.run(runWorkflow(flow, begun, selected));
    expect(ended.status).toBe('done');
    expect(ended.checkout).toEqual({ branch: resolvedBranch, base: resolvedBase });
    const path = join(run.root, 'checkout');
    git(run.origin, 'worktree', 'add', '-b', resolvedBranch, path, resolvedBase);
    writeIssueAt(
      issuePath(run.tracker, 7),
      readFileSync(issuePath(run.tracker, 7), 'utf8').replace('state: open', 'state: closed')
    );
    await engine.run(scanIssuesAndRunningRuns(selected));
    expect(existsSync(path)).toBe(false);
    expect(git(run.origin, 'branch', '--list', resolvedBranch)).toBe('');
  });

  it('skips redirected checkout metadata without running an attacker filter', async () => {
    const run = setup();
    const attacker = join(run.path, 'attacker');
    const marker = join(run.root, 'filter-ran');
    git(run.origin, 'clone', '--no-checkout', run.origin, attacker);
    git(attacker, 'read-tree', run.head);
    git(attacker, 'config', 'filter.planted.clean', `touch ${marker}; cat`);
    write(run.path, {
      '.gitattributes': '*.txt filter=planted\n',
      'landed.txt': 'dirty',
      '.git': `gitdir: ${join(attacker, '.git')}\n`,
    });
    await run.clean();
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(run.path, 'landed.txt'), 'utf8')).toBe('dirty');
    expect(git(run.origin, 'rev-parse', 'agentgraph/7')).toBe(run.head);
  });

  it('disables trusted repository clean filters while checking dirty files', async () => {
    const run = setup();
    const head = commit(run.path, { '.gitattributes': '*.txt filter=planted\n' });
    const marker = join(run.root, 'filter-ran');
    git(run.origin, 'config', 'filter.planted.clean', `touch ${marker}; cat`);
    git(run.origin, 'config', 'filter.planted.required', 'true');
    write(run.path, { 'landed.txt': 'change' });
    await Effect.runPromise(removeBranch(run.origin, 'agentgraph/7', 'main', head));
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(run.path, 'landed.txt'), 'utf8')).toBe('change');
    expect(git(run.origin, 'rev-parse', 'agentgraph/7')).toBe(head);
  });

  it('skips a checkout with missing metadata without crashing', async () => {
    const run = setup();
    rmSync(join(run.path, '.git'));
    await run.clean();
    expect(existsSync(run.path)).toBe(true);
    expect(git(run.origin, 'rev-parse', 'agentgraph/7')).toBe(run.head);
  });

  it('does not fetch issues for a finished dirty branch across two passes', async () => {
    const run = setup();
    git(run.origin, 'update-ref', 'refs/heads/main', run.head, git(run.origin, 'rev-parse', 'main'));
    write(run.path, { 'landed.txt': 'dirty' });
    writeIssueAt(
      issuePath(run.tracker, 7),
      readFileSync(issuePath(run.tracker, 7), 'utf8').replace('state: open', 'state: closed')
    );
    writeIssueAt(issuePath(run.tracker, 8), '---\ntitle: Landed\nstate: merged\nauthor: morgan\nlabels: []\n---\n');
    write(run.tracker, { '8/pull.json': JSON.stringify({ branch: 'agentgraph/7', base: 'main', head: run.head }) });
    say(run, { issue: 8, kind: 'merged', actor: 'morgan', trusted: true, at: '2026-10-16T00:01:00.000Z' });
    const engine = services(run, []);
    await engine.run(Effect.flatMap(Store, s => s.put({ ...fresh(), checkout: run.checkout, status: 'done' })));
    const fetched: number[] = [];
    await engine.run(
      Effect.updateService(
        Effect.andThen(scanIssuesAndRunningRuns(graph), scanIssuesAndRunningRuns(graph)),
        Tracker,
        tracker => ({
          ...tracker,
          issue: n => {
            fetched.push(n);
            return tracker.issue(n);
          },
        })
      )
    );
    expect(fetched).toEqual([]);
    expect(readFileSync(join(run.path, 'landed.txt'), 'utf8')).toBe('dirty');
    expect(git(run.origin, 'rev-parse', 'agentgraph/7')).toBe(run.head);
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
