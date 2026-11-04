import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  save(join(at, 'v2', 'score.json'), { ...makeScore(true), answers: 1 });
  save(join(at, 'v2', 'diff.patch'), `${diff}\n`);
  save(join(at, 'v2', 'meta.json'), { answers: 1, ms: 60_000 });
  save(join(at, 'v2', 'graph', 'settings.yaml'), 'limits: {}\n');
  git(root, 'init', '-q', '--bare', join(at, 'v2', 'forge', 'origin.git'));
  await writeImportedRun({ repo, tracker: join(at, 'v2', 'forge'), data: join(at, 'v2', 'data') }, merged, {
    version: 'old',
    from: base,
    input: { case: 'demo', arm: 'v2', repeat: 1 },
  });
  save(join(at, 'judge', 'human-v2', 'opus.json'), {
    judge: 'opus',
    order: ['human', 'v2'],
    prefer: 'B',
    A: { findings: [{ severity: 'high' }] },
    B: { findings: [] },
  });
  return { root, old };
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
});
