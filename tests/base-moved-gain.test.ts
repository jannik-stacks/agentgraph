import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { tick } from '../src/run/trigger.ts';
import { Store } from '../src/store.ts';
import { compileWorkflow } from '../src/workflow.ts';
import { reply, result, start, wrote } from './fixtures.ts';
import { git, issuePath, writeIssueAt } from './kit.ts';
import { graph, judged, services, say, comment } from './world.ts';
import { parked, merging, behind } from './base-moved-fixtures.ts';

const removal = async (file = 'hex.ts') => {
  const where = await parked();
  writeIssueAt(
    issuePath(where.tracker, 20),
    '---\ntitle: Remove fromHex and toHex\nstate: closed\nauthor: morgan\nlabels: []\n---\n\nThey copy @scure/base. Call hex.decode and hex.encode instead.\n'
  );
  writeIssueAt(
    issuePath(where.tracker, 21),
    '---\ntitle: Drop the hex helpers\nstate: merged\nauthor: morgan\nlabels: []\n---\n\nCloses #20\n'
  );
  writeIssueAt(issuePath(where.tracker, 21, 'pull.json'), JSON.stringify({ branch: 'hex', base: 'main', head: 'y' }));
  const mover = join(where.root, 'mover');
  git(where.root, 'clone', '-q', where.origin, mover);
  writeFileSync(join(mover, file), 'export const hex = 1\n');
  git(mover, 'add', '-A');
  git(mover, 'commit', '-q', '-m', 'refactor: drop fromHex and toHex (#21)');
  git(mover, 'push', '-q', 'origin', 'main');
  return where;
};

const upstream = {
  ...graph,
  checks: {
    ...graph.checks,
    upstream: {
      ...graph.checks.claims!,
      name: 'upstream',
      mode: 'block' as const,
      each: 'merged',
    },
  },
};
const said = /Remove fromHex and toHex \(issue\)\n\nThey copy @scure\/base/;
const stored = (run: ReturnType<typeof services>['run']) =>
  run(Effect.flatMap(Store, s => s.get('run-7'))).then(r => r!);

describe('what the base gained', () => {
  it('reaches a judge per merged hunk, which sends the run back with the reason for the removal', async () => {
    const where = await removal();
    const { specs, run } = services(where, [
      [start('j'), result({ pass: false, why: 'hello.txt still calls fromHex' })],
      [start('i1'), reply({ kind: 'ask', question: 'Switch to hex.decode?' })],
    ]);
    await run(tick(merging({ checks: ['upstream'] }, upstream)));
    expect(behind(where)).toBe('0');
    const [judge, session] = specs.map(s => s.prompt);
    expect(judge).toMatch(said);
    expect(judge).toContain('Drop the hex helpers (pull request)');
    expect(judge).toContain('+export const hex = 1');
    expect(judge).toContain('## This change');
    expect(session).toMatch(
      /^the merge step sent this back: upstream: diff --git a\/hex.ts b\/hex.ts\nhello.txt still calls fromHex/
    );
    expect(session).toMatch(said);
    expect(await stored(run)).toMatchObject({
      step: 'implement',
      status: 'waiting',
    });
    expect((await stored(run)).moved).toBeUndefined();
  });

  it('checks a done run with its pull request open and reopens it when a check fails', async () => {
    const where = await removal();
    const { specs, run } = services(where, [
      [start('j'), result({ pass: false, why: 'still calls fromHex' })],
      [start('i1'), reply({ kind: 'ask', question: 'Switch?' })],
    ]);
    await run(Effect.flatMap(Store, s => Effect.flatMap(s.get('run-7'), r => s.put({ ...r!, status: 'done' }))));
    await run(tick(merging({ checks: ['upstream'] }, upstream)));
    expect(specs.map(s => s.prompt)[1]).toMatch(/^the merge step sent this back: upstream/);
    expect(await stored(run)).toMatchObject({
      step: 'implement',
      status: 'waiting',
    });
  });

  it('keeps the range for a run waiting on a question, and its answer resumes with what the base gained', async () => {
    const where = await removal();
    const { specs, run } = services(where, [
      [start('r1'), wrote('hello.txt', 'hello\n'), reply({ kind: 'comment', body: 'Fine.' })],
    ]);
    await run(
      Effect.flatMap(Store, s =>
        Effect.flatMap(s.get('run-7'), r =>
          s.put({
            ...r!,
            step: 'review',
            status: 'waiting',
            reason: 'Which tone?',
          })
        )
      )
    );
    await run(tick(merging({ checks: ['upstream'] }, upstream)));
    expect(specs).toHaveLength(0);
    expect((await stored(run)).moved?.onto).toBe(git(where.origin, 'rev-parse', 'main'));
    say(where, comment(7, 'morgan', true, '/agent formal', new Date(Date.now() - 60_000).toISOString()));
    await run(tick(merging({ checks: ['upstream'] }, upstream)));
    expect(specs[0]!.prompt).toMatch(said);
    expect((await stored(run)).moved).toBeUndefined();
  });

  it('passes and forgets the range when the judge finds nothing', async () => {
    const where = await removal();
    const { specs, run } = services(where, [judged]);
    await run(tick(merging({ checks: ['upstream'] }, upstream)));
    expect(specs).toHaveLength(1);
    expect(await stored(run)).toMatchObject({
      step: 'merge',
      status: 'waiting',
    });
    expect((await stored(run)).moved).toBeUndefined();
    await run(tick(merging({ checks: ['upstream'] }, upstream)));
    expect(specs).toHaveLength(1);
  });

  it('asks on a conflict when the step says so, though it has a way back', async () => {
    const where = await removal('hello.txt');
    const { specs, run } = services(where, []);
    await run(tick(merging({ conflict: 'ask' })));
    await run(tick(merging({ conflict: 'ask' })));
    expect(specs).toHaveLength(0);
    expect(await stored(run)).toMatchObject({
      step: 'merge',
      status: 'waiting',
    });
    expect((await stored(run)).reason).toMatch(/agentgraph\/7 no longer rebases onto main: conflicts in hello.txt/);
  });

  it('refuses conflict and each values the engine cannot honor', () => {
    const names = { agents: ['a'], skills: [], checks: [] };
    const text = '---\non: dispatch\nsteps:\n  work: { agent: a, each: merged }\n  merge: { wait: human }\n---\n';
    expect(compileWorkflow('w.md', text, names).problems[0]?.message).toMatch(/each/);
    expect(
      compileWorkflow('w.md', '---\non: dispatch\nsteps:\n  merge: { wait: human, conflict: back }\n---\n', names)
        .problems[0]?.message
    ).toMatch(/back needs back/);
  });
});
