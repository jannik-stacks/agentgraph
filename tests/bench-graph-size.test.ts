import { readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readGraphSize, writeGraphSizeLabels } from '../bench/graph-size.ts';
import { readRunLabels } from '../src/labels.ts';
import { git, tmp, write } from './kit.ts';

it('counts graph text and scripts, recovers a tree, and writes labels once', async () => {
  const dir = tmp('graph-size');
  const graph = join(dir, 'graph');
  const run = join(dir, 'data', 'run-1');
  try {
    write(graph, {
      'agents/a.md': 'Read this.\n',
      'workflows/a.md': '---\nsteps: {}\n---\nDo work.\n',
      'checks/a.md': 'Tests pass.\n',
      'skills/a.md': 'Use tools.\n',
      'scripts/a.sh': 'echo one\n\n  \necho two\n',
      'README.md': 'Not counted.',
      'node_modules/noise/checks/a.md': 'Not counted.',
    });
    const size = { words: 12, checks: 1, scriptLines: 2 };
    expect(readGraphSize(graph)).toEqual(size);
    git(graph, 'init', '-q');
    git(graph, 'add', '.');
    const tree = git(graph, 'write-tree');
    expect(readGraphSize(join(graph, '.git'), tree)).toEqual(size);
    write(run, { 'run.json': JSON.stringify({ id: 'run-1', workflow: 'issue', started: '', graphTree: tree }) });
    expect(await writeGraphSizeLabels([dir])).toEqual({ written: 1, unchanged: 0, skipped: 0 });
    const log = readFileSync(join(run, 'labels.jsonl'), 'utf8');
    expect(readRunLabels(join(dir, 'data'), 'run-1')).toEqual({
      'graph-words': '12',
      'graph-checks': '1',
      'graph-script-lines': '2',
    });
    renameSync(graph, join(dir, 'saved-graph'));
    expect(await writeGraphSizeLabels([run], join(dir, 'saved-graph', '.git'))).toEqual({
      written: 0,
      unchanged: 1,
      skipped: 0,
    });
    expect(readFileSync(join(run, 'labels.jsonl'), 'utf8')).toBe(log);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
