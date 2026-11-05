import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRunLabels } from '../src/labels.ts';
import { getRunOrigin } from '../src/meta.ts';
import { readRecordSync, writeFileAtomic } from '../src/store.ts';
import type { RunRecord } from '../src/workflow.ts';
import { readTuneMigration, writeTuneMigration } from '../tune/migrate.ts';
import { readTuneSteps } from '../tune/runs.ts';
import { git, tmp } from './kit.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const makeEval = (candidate: string, split: string) => ({
  candidate,
  split,
  cases: ['c1'],
  quality: 1,
  ci: [1, 1],
  usd: 1,
  minutes: 2,
  codex: 0,
  claude5h: 0,
});

const makeStep = (id: string, iteration: number, parent: string, graph: string, verdict: string) => ({
  id,
  iteration,
  parent,
  proposer: iteration ? 'manual' : 'retro',
  graph,
  rationale: `why ${id}`,
  diff: parent ? 'diff --git a b' : '',
  evals: [makeEval(id, 'fit'), ...(verdict === 'kept' && !iteration ? [makeEval(id, 'test')] : [])],
  verdict,
  why: `ruled ${id}`,
  at: `2026-01-0${iteration + 1}T00:00:00.000Z`,
});

const setup = () => {
  const root = tmp('tune-migrate');
  dirs.push(root);
  const dir = join(root, 'repo', 'work');
  mkdirSync(dir, { recursive: true });
  const bare = join(dir, 'graph.git');
  git(dir, 'init', '-q', '--bare', bare);
  const commit = (msg: string, parent?: string) => {
    const tree = git(dir, `--git-dir=${bare}`, 'mktree', '--missing');
    return git(dir, `--git-dir=${bare}`, 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', msg);
  };
  const init = commit('init');
  const next = commit('next', init);
  git(dir, `--git-dir=${bare}`, 'update-ref', 'refs/cand/i000-init', init);
  git(dir, `--git-dir=${bare}`, 'update-ref', 'refs/cand/i001-manual', next);
  writeFileAtomic(join(dir, 'tune.json'), { engine: 'v1' });
  writeFileSync(
    join(dir, 'iterations.jsonl'),
    [makeStep('i000-init', 0, '', init, 'kept'), makeStep('i001-manual', 1, init, next, 'discarded')]
      .map(s => `${JSON.stringify(s)}\n`)
      .join('')
  );
  const input = { case: 'c1', labels: { cand: 'i001-manual' } };
  writeFileAtomic(join(dir, 'attempts', '1', 'input.json'), { ...input, attempt: 1 });
  const run = {
    id: 'run-1',
    workflow: 'loop',
    step: 'done',
    status: 'done',
    tries: 0,
    rounds: {},
    sessions: {},
    started: '2026-01-02T00:00:00.000Z',
    meta: { engine: { origin: { plugin: 'bench', version: 'v1', job: 'c1', input } } },
  } as RunRecord;
  writeFileAtomic(join(dir, 'data', 'run-1', 'run.json'), run);
  writeFileSync(
    join(dir, 'data', 'run-1', 'labels.jsonl'),
    `${JSON.stringify({ at: run.started, key: 'cand', value: 'i001-manual' })}\n`
  );
  return { dir, bare, init, next };
};

describe('tune migrate', () => {
  it('turns iterations.jsonl into control runs, relabels cand as variant and moves the refs', async () => {
    const s = setup();
    const plan = readTuneMigration(s.dir);
    expect(plan.problems).toEqual([]);
    await writeTuneMigration(s.dir, plan);
    const { steps, pending } = readTuneSteps(s.dir);
    expect(pending).toEqual([]);
    expect(steps.map(t => [t.id, t.parent, t.base, t.verdict, t.evals.map(e => `${e.variant}:${e.split}`)])).toEqual([
      ['i000-init', '', '', 'kept', ['i000-init:fit', 'i000-init:test']],
      ['i001-manual', 'i000-init', s.init, 'discarded', ['i001-manual:fit']],
    ]);
    const data = join(s.dir, 'data');
    expect(readRunLabels(data, 'run-1')).toEqual({ variant: 'i001-manual', tune: 'repo/work', iteration: '1' });
    const run = JSON.parse(readRecordSync(join(data, 'run-1', 'run.json'))!) as RunRecord;
    expect(getRunOrigin(run.meta)?.input).toEqual({ case: 'c1', labels: { variant: 'i001-manual' } });
    expect(JSON.parse(readFileSync(join(s.dir, 'attempts/1/input.json'), 'utf8')).labels).toEqual({
      variant: 'i001-manual',
    });
    expect(git(s.dir, `--git-dir=${s.bare}`, 'for-each-ref', '--format=%(refname)')).toBe(
      'refs/variant/i000-init\nrefs/variant/i001-manual'
    );
    expect(existsSync(join(s.dir, 'iterations.jsonl.migrated'))).toBe(true);
    expect(readTuneMigration(s.dir).problems).toEqual(['already has control runs']);
  });

  it('refuses a tune dir of the older hub.git layout', () => {
    const s = setup();
    rmSync(s.bare, { recursive: true });
    rmSync(join(s.dir, 'data'), { recursive: true });
    expect(readTuneMigration(s.dir).problems).toEqual(['has no graph.git', 'has no data/: run bench/flatten.ts first']);
  });
});
