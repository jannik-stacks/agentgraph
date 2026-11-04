import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { readGraphSize, writeGraphSizeLabels } from '../bench/graph-size.ts';
import { readRunLabels } from '../src/labels.ts';
import { git, tmp, write } from './kit.ts';

it.each([
  { workflow: 'import', graphTree: 'missing', why: 'imported reference has no graph' },
  { workflow: 'issue', graphTree: undefined, why: 'missing graphTree and graph copy' },
  { workflow: 'issue', graphTree: 'missing', why: 'no graph copy or git repository' },
])('skips a run with $why and continues writing labels', async ({ workflow, graphTree, why }) => {
  const dir = tmp('graph-size-skip');
  const skipped = join(dir, 'skipped');
  const available = join(dir, 'available');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    write(join(skipped, 'data', 'run-1'), {
      'run.json': JSON.stringify({ id: 'run-1', workflow, started: '', graphTree }),
    });
    write(join(available, 'data', 'run-2'), {
      'run.json': JSON.stringify({ id: 'run-2', workflow: 'issue', started: '', graphTree: 'available' }),
    });
    write(join(available, 'graph'), { 'agents/a.md': 'Read this.\n' });
    expect(await writeGraphSizeLabels([skipped, available])).toEqual({ written: 1, unchanged: 0, skipped: 1 });
    expect(log.mock.calls).toEqual([[`skip run-1: ${why}`]]);
    expect(existsSync(join(skipped, 'data', 'run-1', 'labels.jsonl'))).toBe(false);
    expect(readRunLabels(join(available, 'data'), 'run-2')).toEqual({
      'graph-words': '2',
      'graph-checks': '0',
      'graph-script-lines': '0',
    });
  } finally {
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

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
    const size = { 'graph-words': 12, 'graph-checks': 1, 'graph-script-lines': 2 };
    expect(await readGraphSize(graph)).toEqual(size);
    git(graph, 'init', '-q');
    git(graph, 'add', '.');
    const tree = git(graph, 'write-tree');
    expect(await readGraphSize(join(graph, '.git'), tree)).toEqual(size);
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

it('labels a graph copy without graphTree and prefers copies over cached trees', async () => {
  const dir = tmp('graph-size-copy');
  const roots = ['first', 'second', 'no-tree'].map(name => join(dir, name));
  try {
    roots.forEach((root, i) => {
      write(join(root, 'data', `run-${i}`), {
        'run.json': JSON.stringify({
          id: `run-${i}`,
          workflow: 'issue',
          started: '',
          ...(i < 2 && { graphTree: 'same' }),
        }),
      });
      write(join(root, 'graph'), { 'agents/a.md': 'word '.repeat(i + 1) });
    });
    expect(await writeGraphSizeLabels(roots)).toEqual({ written: 3, unchanged: 0, skipped: 0 });
    expect(roots.map((root, i) => readRunLabels(join(root, 'data'), `run-${i}`)['graph-words'])).toEqual([
      '1',
      '2',
      '3',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each(['tree', 'blob'])('skips a missing promised %s without starting a transport', async missing => {
  const dir = tmp('graph-size-promised');
  const repository = join(dir, 'repository');
  const transport = join(dir, 'transport');
  const marker = join(dir, 'transport-started');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    write(repository, { 'agents/a.md': 'Read this.\n' });
    git(repository, 'init', '-q');
    git(repository, 'add', '.');
    const tree = git(repository, 'write-tree');
    const object = missing === 'tree' ? tree : git(repository, 'rev-parse', `${tree}:agents/a.md`);
    rmSync(join(repository, '.git', 'objects', object.slice(0, 2), object.slice(2)));
    write(dir, { transport: `#!/bin/sh\ntouch '${marker}'\nexit 1\n` });
    git(repository, 'config', 'remote.origin.url', 'ssh://unavailable/graph');
    git(repository, 'config', 'remote.origin.promisor', 'true');
    git(repository, 'config', 'remote.origin.partialclonefilter', 'blob:none');
    git(repository, 'config', 'core.sshCommand', `sh '${transport}'`);
    const run = join(dir, 'attempt', 'data', 'run-1');
    write(run, { 'run.json': JSON.stringify({ id: 'run-1', workflow: 'issue', started: '', graphTree: tree }) });
    expect(await writeGraphSizeLabels([run], join(repository, '.git'))).toEqual({
      written: 0,
      unchanged: 0,
      skipped: 1,
    });
    expect(log.mock.calls).toEqual([['skip run-1: cannot read graph objects locally']]);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(run, 'labels.jsonl'))).toBe(false);
  } finally {
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
