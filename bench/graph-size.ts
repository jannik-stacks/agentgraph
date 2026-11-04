import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Effect } from 'effect';
import { readRunLabels, writeRunLabels } from '../src/labels.ts';
import { findBenchRuns } from './runs.ts';

export const readGraphSize = (dir: string, tree?: string) => {
  const git = (...args: string[]) =>
    execFileSync('git', ['--git-dir', dir, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const files = tree
    ? git('ls-tree', '-rz', '--name-only', tree).split('\0').filter(Boolean)
    : readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => relative(dir, join(entry.parentPath, entry.name)));
  const size = { words: 0, checks: 0, scriptLines: 0 };
  for (const file of files) {
    if (file.split('/').includes('node_modules')) continue;
    const isMarkdown = /^(prompts|agents|skills|workflows|checks)\/.*\.md$/.test(file);
    const isScript = file.startsWith('scripts/');
    if (!isMarkdown && !isScript) continue;
    const text = tree ? git('show', `${tree}:${file}`) : readFileSync(join(dir, file), 'utf8');
    if (isMarkdown) size.words += text.match(/\S+/g)?.length ?? 0;
    if (/^checks\/.*\.md$/.test(file)) size.checks++;
    if (isScript) size.scriptLines += text.split('\n').filter(line => line.trim()).length;
  }
  return size;
};

export const writeGraphSizeLabels = async (roots: string[], gitDir?: string) => {
  for (const root of roots) if (!existsSync(root)) throw new Error(`${root}: no such set or run dir`);
  const cache = new Map<string, ReturnType<typeof readGraphSize>>();
  let written = 0;
  let unchanged = 0;
  let skipped = 0;
  for (const { run, data, at } of findBenchRuns(roots)) {
    if (run.workflow === 'import') {
      console.log(`skip ${run.id}: imported reference has no graph`);
      skipped++;
      continue;
    }
    if (!run.graphTree) throw new Error(`${run.id}: missing graphTree`);
    let size = cache.get(run.graphTree);
    if (!size) {
      const graph = join(at, 'graph');
      const repository = gitDir ?? [join(data, 'mirror.git'), join(at, 'tracker', 'origin.git')].find(existsSync);
      if (!existsSync(graph) && !repository) throw new Error(`${run.id}: no graph copy or git repository`);
      size = existsSync(graph) ? readGraphSize(graph) : readGraphSize(repository!, run.graphTree);
      cache.set(run.graphTree, size);
    }
    const labels = readRunLabels(data, run.id);
    const patch = Object.fromEntries(
      Object.entries(size)
        .map(([key, value]) => [`graph-${key === 'scriptLines' ? 'script-lines' : key}`, String(value)])
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
