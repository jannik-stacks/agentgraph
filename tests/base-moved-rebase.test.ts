import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { tick } from '../src/run/trigger.ts';
import { Sandbox, SandboxError } from '../src/sandbox.ts';
import { Store } from '../src/store.ts';
import { hostSandbox } from './doubles/sandbox.ts';
import { git, issuePath, writeIssueAt } from './kit.ts';
import { graph, services, readTrace } from './world.ts';

import { parked, moved, behind, rebases, merging } from './base-moved-fixtures.ts';
import { type Command } from '../src/types.ts';
describe('a base that moved', () => {
  const ran = (commands: Command[], script: string) => commands.some(c => c.args.includes(script));
  it('keeps merge-only edits when file-tracker cannot rebase their history', async () => {
    const where = await parked();
    const mover = join(where.root, 'mover');
    git(where.root, 'clone', '-q', where.origin, mover);
    const left = git(where.origin, 'rev-parse', 'agentgraph/7');
    writeFileSync(join(mover, 'right.txt'), 'right\n');
    git(mover, 'add', '-A');
    git(mover, 'commit', '-qm', 'Right');
    git(mover, 'merge', '--no-ff', '--no-commit', left);
    writeFileSync(join(mover, 'resolution.txt'), 'merge-only\n');
    git(mover, 'add', '-A');
    git(mover, 'commit', '-qm', 'Merge');
    const tip = git(mover, 'rev-parse', 'HEAD');
    git(mover, 'push', '-q', 'origin', 'HEAD:agentgraph/7');
    const pr = JSON.parse(readFileSync(issuePath(where.tracker, 8, 'pull.json'), 'utf8'));
    writeIssueAt(issuePath(where.tracker, 8, 'pull.json'), JSON.stringify({ ...pr, head: tip }));
    git(mover, 'reset', '-q', '--hard', 'origin/main');
    writeFileSync(join(mover, 'upstream.txt'), 'upstream\n');
    git(mover, 'add', '-A');
    git(mover, 'commit', '-qm', 'Upstream');
    git(mover, 'push', '-q', 'origin', 'HEAD:main');
    const { run } = services(where, []);
    await run(tick(graph, 7));
    expect(git(where.origin, 'rev-parse', 'agentgraph/7')).toBe(tip);
    expect(git(where.origin, 'show', 'agentgraph/7:resolution.txt')).toBe('merge-only');
    expect(rebases(where)).toContain(false);
  });

  it.each(['workflow', 'symlink', 'oversize'])(
    'refuses unsafe content during a file-tracker rebase: %s',
    async kind => {
      const where = await parked();
      const mover = join(where.root, 'mover');
      git(where.root, 'clone', '-q', where.origin, mover);
      git(mover, 'checkout', '-q', '-B', 'agentgraph/7', 'origin/agentgraph/7');
      if (kind === 'workflow') {
        mkdirSync(join(mover, '.github', 'workflows'), { recursive: true });
        writeFileSync(join(mover, '.github', 'workflows', 'x.yml'), 'run: bad\n');
      } else if (kind === 'symlink') symlinkSync('README.md', join(mover, 'link.txt'));
      else writeFileSync(join(mover, 'big.txt'), 'x'.repeat((1 << 20) + 1));
      git(mover, 'add', '-A');
      git(mover, 'commit', '-qm', 'Unsupported content');
      const tip = git(mover, 'rev-parse', 'HEAD');
      git(mover, 'push', '-q', 'origin', 'agentgraph/7');
      const pr = JSON.parse(readFileSync(issuePath(where.tracker, 8, 'pull.json'), 'utf8'));
      writeIssueAt(issuePath(where.tracker, 8, 'pull.json'), JSON.stringify({ ...pr, head: tip }));
      git(mover, 'reset', '-q', '--hard', 'origin/main');
      writeFileSync(join(mover, 'upstream.txt'), 'upstream\n');
      git(mover, 'add', '-A');
      git(mover, 'commit', '-qm', 'Upstream');
      git(mover, 'push', '-q', 'origin', 'HEAD:main');
      const { run } = services(where, []);
      await run(tick(graph, 7));
      expect(git(where.origin, 'rev-parse', 'agentgraph/7')).toBe(tip);
      expect(rebases(where)).toContain(false);
    }
  );

  it('rebases a clean branch with no model and runs only its script checks when the change stays the same', async () => {
    const where = await moved('other.txt');
    expect(behind(where)).toBe('1');
    const { specs, commands, run } = services(where, []);
    await run(tick(graph));
    expect(behind(where)).toBe('0');
    expect(git(where.origin, 'show', 'agentgraph/7:other.txt')).toBe('upstream');
    expect(git(where.origin, 'show', 'agentgraph/7:hello.txt')).toBe('hello');
    expect(specs).toHaveLength(0);
    expect(ran(commands, '! grep -q TODO hello.txt')).toBe(true);
    const [stored] = await run(Effect.flatMap(Store, s => s.list()));
    expect(stored).toMatchObject({ step: 'merge', status: 'waiting' });
    expect(rebases(where)).toEqual([true]);
  });

  it.each(['base', 'branch', 'graph'])('retries a failed catch-up only after its %s changes', async changed => {
    const where = await moved('other.txt');
    const broken = { ...graph, setup: 'exit 1' };
    const first = services(where, []);
    await first.run(tick(broken));
    const second = services(where, []);
    await second.run(tick(broken));
    expect(second.commands).toHaveLength(0);
    expect(readTrace(where.data, 'run-7').filter(t => 'outcome' in t && t.outcome.kind === 'ask')).toHaveLength(1);

    const mover = join(where.root, 'mover');
    const branch = changed === 'branch' ? 'agentgraph/7' : 'main';
    git(mover, 'fetch', '-q', 'origin');
    git(mover, 'checkout', '-q', '-B', branch, `origin/${branch}`);
    writeFileSync(join(mover, 'next.txt'), 'next\n');
    git(mover, 'add', '-A');
    git(mover, 'commit', '-qm', 'Next');
    if (changed !== 'graph') git(mover, 'push', '-q', 'origin', branch);
    if (changed === 'branch') {
      const file = issuePath(where.tracker, 8, 'pull.json');
      const pull = JSON.parse(readFileSync(file, 'utf8'));
      writeFileSync(file, JSON.stringify({ ...pull, head: git(where.origin, 'rev-parse', branch) }));
    }
    await second.run(tick(changed === 'graph' ? { ...broken, sha: 'next' } : broken));
    expect(second.commands.filter(c => c.args.includes('exit 1'))).toHaveLength(1);
    expect(readTrace(where.data, 'run-7').filter(t => 'outcome' in t && t.outcome.kind === 'ask')).toHaveLength(2);
  });

  it('records a sandbox startup failure once and skips starting it on later passes', async () => {
    const where = await parked();
    let starts = 0;
    const failed = Layer.effect(
      Sandbox,
      Effect.map(Sandbox, sandbox => ({
        ...sandbox,
        checkout: (...args: Parameters<typeof sandbox.checkout>) =>
          args[3]
            ? Effect.andThen(
                Effect.sync(() => starts++),
                Effect.fail(new SandboxError({ reason: 'infra', detail: 'sandbox image is missing' }))
              )
            : sandbox.checkout(...args),
      }))
    ).pipe(Layer.provide(hostSandbox(where.origin)));
    const { run } = services(where, []);
    await run(Effect.provide(tick({ ...graph, sha: 'next' }), failed));
    await run(Effect.provide(tick({ ...graph, sha: 'next' }), failed));
    expect(starts).toBe(1);
    expect(readTrace(where.data, 'run-7')).toContainEqual(
      expect.objectContaining({
        outcome: { kind: 'ask', question: expect.stringContaining('sandbox image is missing') },
      })
    );
  });

  it('runs setup again on the branch even when the base checkout came ready', async () => {
    const where = await moved('other.txt');
    const { run } = services(where, []);
    const ready = Layer.effect(
      Sandbox,
      Effect.map(Sandbox, s => ({
        ...s,
        checkout: (...a: Parameters<typeof s.checkout>) => Effect.map(s.checkout(...a), c => ({ ...c, ready: true })),
      }))
    ).pipe(Layer.provide(hostSandbox(where.origin)));
    await run(Effect.provide(tick({ ...graph, setup: 'true' }), ready));
    expect(readTrace(where.data, 'run-7').some(t => 'setup' in t)).toBe(true);
  });

  it('merges the base into the branch with a plain push by default', async () => {
    const where = await moved('other.txt');
    const before = git(where.origin, 'rev-parse', 'agentgraph/7');
    const { specs, run } = services(where, []);
    await run(tick(merging({ follow: 'merge' })));
    expect(git(where.origin, 'rev-parse', 'agentgraph/7^1')).toBe(before);
    expect(git(where.origin, 'rev-parse', 'agentgraph/7^2')).toBe(git(where.origin, 'rev-parse', 'main'));
    expect(specs).toHaveLength(0);
    const diff = readFileSync(issuePath(where.tracker, 8, 'diff.patch'), 'utf8');
    expect(diff).toContain('hello.txt');
    expect(diff).not.toContain('other.txt');
  });

  it('leaves the branch behind its base when the step follows it not at all', async () => {
    const where = await moved('other.txt');
    const before = git(where.origin, 'rev-parse', 'agentgraph/7');
    const { specs, run } = services(where, []);
    await run(tick(merging({ follow: 'none' })));
    expect(git(where.origin, 'rev-parse', 'agentgraph/7')).toBe(before);
    expect(behind(where)).toBe('1');
    expect(specs).toHaveLength(0);
    const [stored] = await run(Effect.flatMap(Store, s => s.list()));
    expect(stored).toMatchObject({ step: 'merge', status: 'waiting' });
  });
});
