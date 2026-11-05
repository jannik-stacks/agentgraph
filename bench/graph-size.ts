import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Effect } from 'effect';
import { hostGit } from '../src/git.ts';
import { readRunLabels, writeRunLabels } from '../src/labels.ts';
import { findBenchRuns } from './runs.ts';

export const readGraphSize = async (dir: string, tree?: string) => {
  const files = tree
    ? (await Effect.runPromise(hostGit({ GIT_DIR: resolve(dir) }, ['ls-tree', '-rz', '--name-only', tree])))
        .toString('utf8')
        .split('\0')
        .filter(Boolean)
    : readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => relative(dir, join(entry.parentPath, entry.name)));
  const size = { 'graph-words': 0, 'graph-checks': 0, 'graph-script-lines': 0 };
  for (const file of files) {
    if (file.split('/').includes('node_modules')) continue;
    const isMarkdown = /^(prompts|agents|skills|workflows|checks)\/.*\.md$/.test(file);
    const isScript = file.startsWith('scripts/');
    if (!isMarkdown && !isScript) continue;
    const text = tree
      ? (await Effect.runPromise(hostGit({ GIT_DIR: resolve(dir) }, ['show', `${tree}:${file}`]))).toString('utf8')
      : readFileSync(join(dir, file), 'utf8');
    if (isMarkdown) size['graph-words'] += text.match(/\S+/g)?.length ?? 0;
    if (/^checks\/.*\.md$/.test(file)) size['graph-checks']++;
    if (isScript) size['graph-script-lines'] += text.split('\n').filter(line => line.trim()).length;
  }
  return size;
};

export const writeGraphSizeLabels = async (roots: string[], gitDir?: string) => {
  for (const root of roots) if (!existsSync(root)) throw new Error(`${root}: no such set or run dir`);
  const cache = new Map<string, Awaited<ReturnType<typeof readGraphSize>>>();
  let written = 0;
  let unchanged = 0;
  let skipped = 0;
  for (const { run, data, at } of findBenchRuns(roots)) {
    if (run.workflow === 'import') {
      console.log(`skip ${run.id}: imported reference has no graph`);
      skipped++;
      continue;
    }
    const graph = join(at, 'graph');
    let size;
    if (existsSync(graph)) {
      size = await readGraphSize(graph);
    } else {
      if (!run.graphTree) {
        console.log(`skip ${run.id}: missing graphTree and graph copy`);
        skipped++;
        continue;
      }
      size = cache.get(run.graphTree);
      if (!size) {
        const repository =
          gitDir ??
          [join(at, 'mirror.git'), join(data, 'mirror.git'), join(at, 'tracker', 'origin.git')].find(existsSync);
        if (!repository) {
          console.log(`skip ${run.id}: no graph copy or git repository`);
          skipped++;
          continue;
        }
        try {
          size = await readGraphSize(repository, run.graphTree);
        } catch {
          console.log(`skip ${run.id}: cannot read graph objects locally`);
          skipped++;
          continue;
        }
        cache.set(run.graphTree, size);
      }
    }
    const labels = readRunLabels(data, run.id);
    const patch = Object.fromEntries(
      Object.entries(size)
        .map(([key, value]) => [key, String(value)])
        .filter(([key, value]) => labels[key!] !== value)
    );
    if (Object.keys(patch).length) {
      await Effect.runPromise(writeRunLabels(data, run.id, patch));
      written++;
    } else unchanged++;
  }
  return { written, unchanged, skipped };
};

if (import.meta.main) {
  const { positionals, values } = parseArgs({ options: { 'git-dir': { type: 'string' } }, allowPositionals: true });
  if (!positionals.length) throw new Error('Usage: node bench/graph-size.ts <set or run dir>... [--git-dir <repo>]');
  console.log(
    await writeGraphSizeLabels(
      positionals.map(dir => resolve(dir)),
      values['git-dir']
    )
  );
}
