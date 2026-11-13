import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { Step } from '../src/workflow.ts';
import { reply, start, wrote } from './fixtures.ts';
import { git } from './kit.ts';
import { graph, w, world, push, pull, judged, services, readTrace, fresh } from './world.ts';
import { runWorkflow } from '../src/run/drive.ts';

export const parked = async () => {
  const where = world();
  const first = services(where, [
    [start('t1'), reply({ kind: 'comment', body: 'Brief' })],
    [start('i1'), wrote('hello.txt', 'hello\n'), reply(push, pull)],
    judged,
    [start('r1'), reply({ kind: 'comment', body: 'Looks right.' })],
  ]);
  expect(await first.run(runWorkflow(w, fresh(), graph))).toMatchObject({
    step: 'merge',
    status: 'waiting',
    graph: 'fixture',
  });
  return where;
};
export const moved = async (...files: string[]) => {
  const where = await parked();
  const mover = join(where.root, 'mover');
  git(where.root, 'clone', '-q', where.origin, mover);
  for (const file of files) writeFileSync(join(mover, file), 'upstream\n');
  git(mover, 'add', '-A');
  git(mover, 'commit', '-q', '-m', 'upstream');
  git(mover, 'push', '-q', 'origin', 'main');
  return where;
};
export const behind = (where: ReturnType<typeof world>) =>
  git(where.origin, 'rev-list', '--count', 'agentgraph/7..main');
export const rebases = (where: ReturnType<typeof world>) =>
  readTrace(where.data, 'run-7').flatMap(t =>
    'applied' in t && t.applied.proposal.kind === 'rebase' ? [t.applied.ok] : []
  );
export const merging = (fields: Partial<Step>, base = graph) => ({
  ...base,
  workflows: { issue: { ...w, steps: w.steps.map(s => (s.name === 'merge' ? { ...s, ...fields } : s)) } },
});
