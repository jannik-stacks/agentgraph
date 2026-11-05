import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { readFlatSetPlan, writeFlatSet } from '../bench/flatten.ts';
import { type BenchInput, getBenchSlot, readBenchSlots, readSlotRun } from '../bench/runs.ts';
import { writeImportedRun } from '../src/instance.ts';
import { readRunLabels, writeRunLabels } from '../src/labels.ts';
import { git, tmp } from './kit.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const setup = () => {
  const root = tmp('flatten');
  dirs.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  return { set: join(root, 'set'), repo, base: git(repo, 'rev-parse', 'HEAD') };
};

const addOldRun = async (s: ReturnType<typeof setup>, input: BenchInput, k: number) => {
  const at = join(s.set, 'runs', getBenchSlot(input), String(k));
  git(s.repo, 'init', '-q', '--bare', join(at, 'tracker', 'origin.git'));
  writeFileSync(join(at, 'issue.md'), `# ${input.case}\n`);
  const data = join(at, 'data');
  const id = await writeImportedRun({ checkout: s.repo, tracker: join(at, 'tracker'), data }, s.base, {
    version: 'old',
    from: s.base,
    input,
  });
  await Effect.runPromise(writeRunLabels(data, id, { case: input.case }));
  mkdirSync(join(data, 'logs'), { recursive: true });
  writeFileSync(join(data, 'logs', `${id}.gz`), '');
  return { at, data, id };
};

describe('flatten', () => {
  it('moves each old slot attempt into a numbered attempt and its runs into one store, leaving runs/ as it was', async () => {
    const s = setup();
    const a: BenchInput = { case: 'c1', arm: 'v2', repeat: 1 };
    const b: BenchInput = { case: 'c2', arm: 'v2', repeat: 1 };
    const first = await addOldRun(s, a, 1);
    const second = await addOldRun(s, a, 2);
    const other = await addOldRun(s, b, 1);
    const before = readdirSync(join(s.set, 'runs')).toSorted();

    const plan = readFlatSetPlan(s.set);
    expect(plan.problems).toEqual([]);
    expect(plan.attempts.map(x => [x.from, x.attempt])).toEqual(
      [first, second, other].toSorted((x, y) => x.at.localeCompare(y.at)).map((x, i) => [x.at, i + 1])
    );
    await writeFlatSet(s.set, plan);

    expect(readdirSync(join(s.set, 'runs')).toSorted()).toEqual(before);
    expect(existsSync(join(s.set, '.flatten'))).toBe(false);
    expect(readdirSync(join(s.set, 'attempts')).toSorted()).toEqual(['1', '2', '3']);
    const slots = readBenchSlots(s.set);
    expect(slots.get(getBenchSlot(a))?.map(x => x.run?.id)).toEqual(
      plan.attempts.filter(x => x.input.case === 'c1').map(x => x.runs[0]!.id)
    );
    expect(readSlotRun(s.set, b)?.run.id).toBe(other.id);
    const at = plan.attempts.find(x => x.runs[0]!.id === other.id)!;
    expect(readFileSync(join(s.set, 'attempts', String(at.attempt), 'issue.md'), 'utf8')).toBe('# c2\n');
    expect(existsSync(join(s.set, 'attempts', String(at.attempt), 'tracker', 'origin.git'))).toBe(true);
    expect(readRunLabels(join(s.set, 'data'), other.id)).toMatchObject({
      case: 'c2',
      set: 'set',
      attempt: String(at.attempt),
    });
    expect(existsSync(join(s.set, 'data', 'logs', `${first.id}.gz`))).toBe(true);
    expect(readFlatSetPlan(s.set).problems).toEqual([`${s.set} already has attempts/ or data/`]);
  });

  it('refuses a set where two attempts hold the same run id', async () => {
    const s = setup();
    const a: BenchInput = { case: 'c1', arm: 'v2', repeat: 1 };
    const first = await addOldRun(s, a, 1);
    const copy = join(s.set, 'runs', getBenchSlot(a), '2', 'data', first.id);
    cpSync(join(first.data, first.id), copy, { recursive: true });

    const plan = readFlatSetPlan(s.set);
    expect(plan.problems).toEqual([
      `run ${first.id} is in ${first.at} and ${join(s.set, 'runs', getBenchSlot(a), '2')}`,
    ]);
  });
});
