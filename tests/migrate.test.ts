import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyOldBenchRuns } from '../bench/migrate.ts';
import { readAttemptRun, readBenchRows, readRunChange } from '../bench/runs.ts';
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

const makeOldBench = async () => {
  const root = tmp('migrate');
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
  const out = join(old, 'abcd1234', 'codex-sol', 'r1');
  save(join(out, 'point.json'), {
    harness: 'codex',
    model: 'sol',
    repeat: 1,
    engine: 'abcd1234',
    set: 'bench',
    graphs: { v2: 'tree1' },
  });
  const at = join(out, 'demo');
  save(join(at, 'base', 'score.json'), makeScore(false));
  save(join(at, 'human', 'score.json'), makeScore(true));
  save(join(at, 'human', 'diff.patch'), `${diff}\n`);
  save(join(at, 'valid.json'), { image: 'x' });
  const addArm = async (
    dir: string,
    o: { score?: object; meta?: object; tracker?: 'forge' | 'tracker'; usage?: object; patch?: string } = {}
  ) => {
    save(join(dir, 'score.json'), o.score ?? { ...makeScore(true), answers: 1 });
    save(join(dir, 'diff.patch'), o.patch ?? `${diff}\n`);
    save(join(dir, 'meta.json'), o.meta ?? { answers: 1, ms: 60_000 });
    if (o.usage) return save(join(dir, 'usage.json'), o.usage);
    save(join(dir, 'graph', 'settings.yaml'), 'limits: {}\n');
    const tracker = join(dir, o.tracker ?? 'forge');
    git(root, 'init', '-q', '--bare', join(tracker, 'origin.git'));
    const id = await writeImportedRun({ repo, tracker, data: join(dir, 'data') }, merged, {
      version: 'old',
      from: base,
      input: { case: 'demo', arm: 'v2', repeat: 1 },
    });
    const record = join(dir, 'data', id, 'run.json');
    if (o.tracker === 'tracker') save(record, { ...JSON.parse(readFileSync(record, 'utf8')), meta: {} });
    save(
      join(dir, 'data', id, 'trace.jsonl'),
      [
        { at: '2026-10-22T10:00:00.000Z', key: 'k', event: { type: 'start', model: 'smart' } },
        { at: '2026-10-22T10:01:00.000Z', key: 'k', session: { usd: 0.5 } },
      ]
        .map(t => JSON.stringify(t))
        .join('\n')
    );
  };
  await addArm(join(at, 'v2'));
  save(join(at, 'judge', 'human-v2', 'opus.json'), {
    judge: 'opus',
    order: ['human', 'v2'],
    prefer: 'B',
    A: { findings: [{ severity: 'high' }] },
    B: { findings: [] },
  });
  return { root, old, out, at, repo, addArm };
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

  it('keeps a point per engine and graph, and the tracker layout and origin-less runs of later engines', async () => {
    const { root, old, out, addArm } = await makeOldBench();
    const other = join(old, 'ef567890', 'codex-sol', 'r1');
    save(join(other, 'point.json'), {
      ...JSON.parse(readFileSync(join(out, 'point.json'), 'utf8')),
      engine: 'ef567890',
    });
    save(join(other, 'demo', 'human', 'score.json'), makeScore(true));
    await addArm(join(other, 'demo', 'v2'), { score: makeScore(false), tracker: 'tracker' });
    await copyOldBenchRuns(old, old, join(root, 'repos'));
    const v2 = readBenchRows([join(old, 'runs')]).filter(r => r.labels.arm === 'v2');
    expect(v2.map(r => [r.labels.engine, r.hidden]).toSorted()).toEqual([
      ['abcd1234', 1],
      ['ef567890', 0],
    ]);
    expect(v2.map(r => readRunChange(r.at, readAttemptRun(r.at)!.run).includes('a + b'))).toEqual([true, true]);
  });

  it('keeps every attempt, numbered or in the attic, and an arm saved without its run data', async () => {
    const { root, old, at, addArm } = await makeOldBench();
    await addArm(join(at, 'v2.1792604940434'), { meta: { ms: 30_000, infra: 'docker unreachable' } });
    await addArm(join(at, 'floor'), { usage: { sessions: 2, usd: 1.5, tokens: {} } });
    await copyOldBenchRuns(old, old, join(root, 'repos'));
    const rows = readBenchRows([join(old, 'runs')]);
    const v2 = rows.find(r => r.labels.arm === 'v2')!;
    expect(readdirSync(join(v2.at, '..'))).toEqual(['1', '2']);
    expect(v2).toMatchObject({ minutes: 1.5, usd: 1, hidden: 1 });
    const floor = rows.find(r => r.labels.arm === 'floor')!;
    expect(floor).toMatchObject({ usd: 1.5, hidden: 1 });
    expect(readRunChange(floor.at, readAttemptRun(floor.at)!.run)).toContain('a + b');
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
