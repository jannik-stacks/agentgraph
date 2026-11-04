import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyOldBenchRuns } from '../bench/migrate.ts';
import { makeBenchInput } from '../bin/bench.ts';
import { isBenchRunDone, readAttemptRun, readBenchRows, readRunChange } from '../bench/runs.ts';
import { writeImportedRun } from '../src/instance.ts';
import { git, tmp } from './kit.ts';

const save = (path: string, value: unknown) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
};

const makeScore = (hidden: boolean) => ({
  applied: true,
  suite: { ok: true, ms: 1, tail: '' },
  hidden: { ok: hidden, ms: 1, tail: hidden ? '' : 'FAIL sum' },
});

const makeTokens = (input: number) => ({ smart: { input, cacheRead: 0, cacheWrite: 0, output: 1 } });

const SAVED_RETRIES = [
  { retry: 'gone', attempts: ['1'] },
  { retry: 'there without data', attempts: ['1', '2'] },
];

const buildTemplate = async () => {
  const root = tmp('migrate-template');
  const repo = join(root, 'repos', 'demo');
  save(join(repo, 'sum.js'), 'module.exports = (a, b) => a - b;\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  save(join(repo, 'sum.js'), 'module.exports = (a, b) => a + b;\n');
  git(repo, 'commit', '-qam', 'fix');
  const merged = git(repo, 'rev-parse', 'HEAD');
  const diff = git(repo, 'diff', base, merged);
  const old = join(root, 'bench');
  const kase = join(old, 'cases', 'demo');
  save(join(kase, 'case.json'), { repo: 'me/demo', base, merged, title: 'Fix sum', test: 'node t.js' });
  save(join(kase, 'issue.md'), '# Fix sum\n\nsum subtracts.\n');
  save(join(kase, 'merged.diff'), `${diff}\n`);
  save(join(old, 'set.json'), { cases: [{ id: 'demo', repo: 'me/demo' }] });
  save(join(old, 'abcd1234', 'codex-sol', 'r1', 'point.json'), {
    harness: 'codex',
    model: 'sol',
    repeat: 1,
    engine: 'abcd1234',
    set: 'bench',
    graphs: { v2: 'tree1' },
  });
  const at = join(old, 'abcd1234', 'codex-sol', 'r1', 'demo');
  save(join(at, 'base', 'score.json'), makeScore(false));
  save(join(at, 'human', 'score.json'), makeScore(true));
  save(join(at, 'human', 'diff.patch'), `${diff}\n`);
  save(join(at, 'valid.json'), { image: 'x' });
  save(join(at, 'judge', 'human-v2', 'opus.json'), {
    judge: 'opus',
    order: ['human', 'v2'],
    prefer: 'B',
    A: { findings: [{ severity: 'high' }] },
    B: { findings: [] },
  });
  const arm = join(root, 'arm');
  save(join(arm, 'graph', 'settings.yaml'), 'limits: {}\n');
  git(root, 'init', '-q', '--bare', join(arm, 'forge', 'origin.git'));
  const id = await writeImportedRun({ repo, tracker: join(arm, 'forge'), data: join(arm, 'data') }, merged, {
    version: 'old',
    from: base,
    input: { case: 'demo', arm: 'v2', repeat: 1 },
  });
  save(
    join(arm, 'data', id, 'trace.jsonl'),
    [
      { at: '2026-10-22T10:00:00.000Z', key: 'k', event: { type: 'start', model: 'smart' } },
      { at: '2026-10-22T10:01:00.000Z', key: 'k', session: { usd: 0.5 } },
    ]
      .map(t => JSON.stringify(t))
      .join('\n')
  );
  return { root, diff, record: join('data', id, 'run.json') };
};
let template: ReturnType<typeof buildTemplate> | undefined;

const makeOldBench = async () => {
  const t = await (template ??= buildTemplate());
  const root = tmp('migrate');
  cpSync(t.root, root, { recursive: true });
  const old = join(root, 'bench');
  const out = join(old, 'abcd1234', 'codex-sol', 'r1');
  const at = join(out, 'demo');
  const addArm = (
    dir: string,
    o: { score?: object; meta?: object; tracker?: 'forge' | 'tracker'; usage?: object; patch?: string } = {}
  ) => {
    if (!o.usage) cpSync(join(root, 'arm'), dir, { recursive: true });
    save(join(dir, 'score.json'), o.score ?? { ...makeScore(true), answers: 1 });
    save(join(dir, 'diff.patch'), o.patch ?? `${t.diff}\n`);
    save(join(dir, 'meta.json'), o.meta ?? { answers: 1, ms: 60_000 });
    if (o.usage) return save(join(dir, 'usage.json'), o.usage);
    if (o.tracker !== 'tracker') return;
    renameSync(join(dir, 'forge'), join(dir, 'tracker'));
    save(join(dir, t.record), { ...JSON.parse(readFileSync(join(dir, t.record), 'utf8')), meta: {} });
  };
  addArm(join(at, 'v2'));
  return { root, old, out, at, repo: join(root, 'repos', 'demo'), addArm };
};

describe('bench/migrate.ts', () => {
  it('copies an old bench into run slots with its scores, gate and judge, once', async () => {
    const { root, old } = await makeOldBench();
    await copyOldBenchRuns(old, old, join(root, 'repos'));
    const rows = readBenchRows([join(old, 'runs')]);
    expect(rows.map(r => r.labels.arm).toSorted()).toEqual(['base', 'human', 'v2']);
    const v2 = rows.find(r => r.labels.arm === 'v2')!;
    expect(v2).toMatchObject({
      hidden: 1,
      suite: 1,
      answers: 1,
      vsHuman: { opus: 1 },
      against: { critical: 0, high: 1 },
      labels: { harness: 'codex', model: 'sol', graph: 'tree1', engine: 'abcd1234' },
    });
    expect(v2.results['bench/judge']).toBeDefined();
    expect(readRunChange(v2.at, readAttemptRun(v2.at)!.run)).toContain('a + b');
    expect(rows.find(r => r.labels.arm === 'human')!.results['bench/valid']).toMatchObject({ pass: true });
    const checks = readFileSync(join(v2.data, v2.run, 'checks.jsonl'), 'utf8');
    await copyOldBenchRuns(old, old, join(root, 'repos'));
    expect(readBenchRows([join(old, 'runs')])).toHaveLength(3);
    expect(readFileSync(join(v2.data, v2.run, 'checks.jsonl'), 'utf8')).toBe(checks);
  });

  it('adds a later engine of the same evaluation as an attempt with its own row, and another graph as its own slot', async () => {
    const { root, old, out, addArm } = await makeOldBench();
    const point = JSON.parse(readFileSync(join(out, 'point.json'), 'utf8'));
    save(join(out, 'point.json'), { ...point, at: '2026-10-01T00:00:00.000Z' });
    const later = join(old, 'ef567890', 'codex-sol', 'r1');
    save(join(later, 'point.json'), { ...point, engine: 'ef567890', at: '2026-10-02T00:00:00.000Z' });
    save(join(later, 'demo', 'human', 'score.json'), makeScore(true));
    await addArm(join(later, 'demo', 'v2'), { score: makeScore(false), tracker: 'tracker' });
    const other = join(old, 'ab12', 'codex-sol', 'r1');
    save(join(other, 'point.json'), { ...point, engine: 'ab12', graphs: { v2: 'tree2' } });
    save(join(other, 'demo', 'human', 'score.json'), makeScore(true));
    await addArm(join(other, 'demo', 'v2'));
    await copyOldBenchRuns(old, old, join(root, 'repos'));
    await copyOldBenchRuns(old, old, join(root, 'repos'));
    const v2 = readBenchRows([join(old, 'runs')]).filter(r => r.labels.arm === 'v2');
    expect(v2.map(r => [r.labels.graph, r.labels.engine, r.hidden, r.minutes]).toSorted()).toEqual([
      ['tree1', 'abcd1234', 1, 1],
      ['tree1', 'ef567890', 0, 1],
      ['tree2', 'ab12', 1, 1],
    ]);
    const merged = v2.find(r => r.labels.engine === 'ef567890')!;
    expect(readdirSync(join(merged.at, '..'))).toEqual(['1', '2']);
    expect(readRunChange(merged.at, readAttemptRun(merged.at)!.run)).toContain('a + b');
  });

  it('publishes a later engine into an occupied slot whole, so an interrupted merge resumes it once', async () => {
    const { root, old, out, addArm } = await makeOldBench();
    const point = JSON.parse(readFileSync(join(out, 'point.json'), 'utf8'));
    save(join(out, 'point.json'), { ...point, at: '2026-10-01T00:00:00.000Z' });
    await copyOldBenchRuns(old, old, join(root, 'repos'));
    const later = join(old, 'ef567890', 'codex-sol', 'r1');
    save(join(later, 'point.json'), { ...point, engine: 'ef567890', at: '2026-10-02T00:00:00.000Z' });
    save(join(later, 'demo', 'human', 'score.json'), makeScore(true));
    await addArm(join(later, 'demo', 'v2.1792604940434'), { meta: { ms: 30_000, infra: 'docker unreachable' } });
    await addArm(join(later, 'demo', 'v2'), { score: makeScore(false) });
    save(join(later, 'demo', 'v2', 'score.json'), '{');
    await expect(copyOldBenchRuns(old, old, join(root, 'repos'))).rejects.toThrow();
    const rows = () =>
      readBenchRows([join(old, 'runs')])
        .filter(r => r.labels.arm === 'v2')
        .map(r => [r.labels.engine, r.hidden, r.minutes, r.usd])
        .toSorted();
    expect(rows()).toEqual([['abcd1234', 1, 1, 0.5]]);
    save(join(later, 'demo', 'v2', 'score.json'), makeScore(false));
    await copyOldBenchRuns(old, old, join(root, 'repos'));
    const both = [
      ['abcd1234', 1, 1, 0.5],
      ['ef567890', 0, 1.5, 1],
    ];
    expect(rows()).toEqual(both);
    const slot = join(readBenchRows([join(old, 'runs')]).find(r => r.labels.arm === 'v2')!.at, '..');
    expect(readdirSync(slot)).toEqual(['1', '2', '3']);
    renameSync(slot, `${join(old, 'runs', '.migrating', 'runs', basename(slot))}.replaced`);
    await copyOldBenchRuns(old, old, join(root, 'repos'));
    expect(rows()).toEqual(both);
    expect(readdirSync(slot)).toEqual(['1', '2', '3']);
    expect(readdirSync(join(old, 'runs', '.migrating', 'runs'))).toEqual([]);
  });

  it('keys a migrated run on the tree id the old drive recorded, so planning the same graph finds it done', async () => {
    const { root, old, out } = await makeOldBench();
    const graphs = join(root, 'engine');
    save(join(graphs, 'examples', 'skills', 'fix', 'SKILL.md'), 'Fix it.\n');
    save(join(graphs, 'examples', 'settings.yaml'), 'limits: {}\n');
    git(graphs, 'init', '-q', '-b', 'main');
    git(graphs, 'add', '-A');
    git(graphs, 'commit', '-qm', 'engine');
    const point = JSON.parse(readFileSync(join(out, 'point.json'), 'utf8'));
    save(join(out, 'point.json'), { ...point, graphs: { v2: git(graphs, 'rev-parse', 'HEAD:./examples') } });
    await copyOldBenchRuns(old, old, join(root, 'repos'));
    const plan = (graph: string) =>
      isBenchRunDone(
        old,
        makeBenchInput({ id: 'demo', repo: 'me/demo' }, 'v2', 1, { point: 'codex:sol', graph }),
        true
      );
    expect(plan(join(graphs, 'examples'))).toBe(true);
    save(join(graphs, 'examples', 'skills', 'fix', 'SKILL.md'), 'Fix it well.\n');
    expect(plan(join(graphs, 'examples'))).toBe(false);
  });

  it('keeps every attempt, numbered or in the attic, and an arm saved without its run data', async () => {
    const { root, old, at, addArm } = await makeOldBench();
    await addArm(join(at, 'v2.1792604940434'), { meta: { ms: 30_000, infra: 'docker unreachable' } });
    await addArm(join(at, 'floor.1792604940434'), { meta: { ms: 60_000, infra: 'docker unreachable' } });
    const split = { agent: 100_000, tools: 20_000, setup: 30_000, checks: 10_000 };
    await addArm(join(at, 'floor'), {
      usage: {
        sessions: 2,
        usd: 1.5,
        checkUsd: 0.2,
        ms: 180_000,
        tokens: {},
        split: { ...split, agent: 160_000, infra: 60_000 },
        attempts: [
          { dir: 'floor.1792604940434', usd: 0.5, checkUsd: 0, ms: 60_000, infra: 'docker unreachable', tokens: {} },
          { dir: 'floor', sessions: 1, usd: 1, checkUsd: 0.2, ms: 120_000, tokens: {}, split },
        ],
      },
    });
    await copyOldBenchRuns(old, old, join(root, 'repos'));
    const rows = readBenchRows([join(old, 'runs')]);
    const v2 = rows.find(r => r.labels.arm === 'v2')!;
    expect(readdirSync(join(v2.at, '..'))).toEqual(['1', '2']);
    expect(v2).toMatchObject({ minutes: 1.5, usd: 1, hidden: 1 });
    const floor = rows.find(r => r.labels.arm === 'floor')!;
    expect(readdirSync(join(floor.at, '..'))).toEqual(['1', '2']);
    expect(floor).toMatchObject({
      usd: 1.5,
      checkUsd: 0.2,
      minutes: 3,
      hidden: 1,
      split: { agent: 160_000, tools: 20_000, setup: 30_000, checks: 10_000, infra: 60_000 },
    });
    expect(readRunChange(floor.at, readAttemptRun(floor.at)!.run)).toContain('a + b');
  });

  it.each(SAVED_RETRIES)('keeps a saved retry whose dir is $retry, counted once', async ({ retry, attempts }) => {
    const { root, old, at, addArm } = await makeOldBench();
    if (retry === 'there without data')
      await addArm(join(at, 'floor.1792604940434'), { meta: { ms: 60_000, infra: 'docker unreachable' }, usage: {} });
    await addArm(join(at, 'floor'), {
      usage: {
        sessions: 2,
        usd: 1.5,
        checkUsd: 0.3,
        ms: 180_000,
        tokens: { smart: { input: 30, cacheRead: 0, cacheWrite: 0, output: 2 } },
        split: { agent: 160_000, tools: 20_000, setup: 30_000, checks: 10_000, infra: 60_000 },
        attempts: [
          {
            dir: 'floor.1792604940434',
            sessions: 1,
            usd: 0.5,
            checkUsd: 0.1,
            ms: 60_000,
            infra: 'docker unreachable',
            tokens: makeTokens(10),
            split: { agent: 60_000, tools: 0, setup: 0, checks: 0 },
          },
          {
            dir: 'floor',
            sessions: 1,
            usd: 1,
            checkUsd: 0.2,
            ms: 120_000,
            tokens: makeTokens(20),
            split: { agent: 100_000, tools: 20_000, setup: 30_000, checks: 10_000 },
          },
        ],
      },
    });
    await copyOldBenchRuns(old, old, join(root, 'repos'));
    const floor = readBenchRows([join(old, 'runs')]).find(r => r.labels.arm === 'floor')!;
    expect(readdirSync(join(floor.at, '..'))).toEqual(attempts);
    expect(floor).toMatchObject({
      checkUsd: 0.3,
      minutes: 3,
      tokens: { smart: { input: 30, cacheRead: 0, cacheWrite: 0, output: 2 } },
      split: { agent: 160_000, tools: 20_000, setup: 30_000, checks: 10_000, infra: 60_000 },
    });
  });

  it('reads infra as the old bench did: an empty diff is a result, a failed setup is not', async () => {
    const { root, old, at, addArm } = await makeOldBench();
    await addArm(join(at, 'floor'), { meta: { ms: 1, infra: 'empty diff' }, patch: '' });
    save(join(at, 'v2', 'score.json'), { ...makeScore(true), setup: { ok: false, ms: 1, tail: 'npm ci failed' } });
    await copyOldBenchRuns(old, old, join(root, 'repos'));
    const rows = readBenchRows([join(old, 'runs')]);
    expect(rows.find(r => r.labels.arm === 'floor')).toMatchObject({ outcome: 'no-change' });
    expect(rows.find(r => r.labels.arm === 'floor')).not.toHaveProperty('infra');
    expect(rows.find(r => r.labels.arm === 'v2')).toMatchObject({ infra: 'setup fails' });
  });

  it('reads a dir without point.json as opencode:smart with its name as the set', async () => {
    const { root, old, at } = await makeOldBench();
    const plain = join(old, 'runs-1');
    save(join(plain, 'log.jsonl'), '');
    save(join(plain, 'demo', 'human', 'score.json'), makeScore(true));
    save(join(plain, 'demo', 'v2', 'meta.json'), { ms: 1 });
    save(join(plain, 'demo', 'v2', 'score.json'), makeScore(false));
    save(join(plain, 'demo', 'v2', 'usage.json'), { usd: 0 });
    save(join(plain, 'demo', 'v2', 'diff.patch'), readFileSync(join(at, 'v2', 'diff.patch'), 'utf8'));
    await copyOldBenchRuns(old, old, join(root, 'repos'));
    const sets = readBenchRows([join(old, 'runs')])
      .filter(r => r.labels.arm === 'v2')
      .map(r => [r.labels.set, r.labels.model]);
    expect(sets.toSorted()).toEqual([
      ['bench', 'sol'],
      ['runs-1', 'smart'],
    ]);
  });

  it('builds each slot aside, so an interrupted pass leaves nothing half done and the next one finishes it', async () => {
    const { root, old, at, addArm } = await makeOldBench();
    await addArm(join(at, 'v2.1792604940434'));
    save(join(at, 'v2.1792604940434', 'meta.json'), '{');
    await expect(copyOldBenchRuns(old, old, join(root, 'repos'))).rejects.toThrow();
    expect(readBenchRows([join(old, 'runs')]).map(r => r.labels.arm)).not.toContain('v2');
    save(join(at, 'v2.1792604940434', 'meta.json'), { ms: 1, infra: 'docker unreachable' });
    await copyOldBenchRuns(old, old, join(root, 'repos'));
    const v2 = readBenchRows([join(old, 'runs')]).find(r => r.labels.arm === 'v2')!;
    expect(v2).toMatchObject({ hidden: 1, vsHuman: { opus: 1 } });
    expect(existsSync(join(v2.at, '..', '2'))).toBe(true);
  });
});
