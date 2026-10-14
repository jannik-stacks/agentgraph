import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { git } from './git.ts';

/** The source directory this module was loaded from. */
export const srcDir = import.meta.dirname;

/** A hash of every file's path and contents under `dir`, so any edit, addition or removal changes it. */
export const fingerprint = (dir: string = srcDir) => {
  const hash = createHash('sha256');
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name))
    .sort();
  for (const file of files) hash.update(`${relative(dir, file).split(sep).join('/')}\0`).update(readFileSync(file));
  return hash.digest('hex').slice(0, 16);
};

/** A short hash of `parts`, each kept apart from the next, so the same parts in the same order give the same key. */
export const digest = (...parts: string[]) => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(`${part}\0`);
  return hash.digest('hex').slice(0, 16);
};

let running: Promise<{ commit?: string; dirty?: boolean; src: string }> | undefined;

/** The engine this process runs: the commit its source is at, whether the source differs from it, and its hash. */
export const engine = () =>
  (running ??= (async () => {
    const src = fingerprint();
    const commit = await git(srcDir, ['rev-parse', 'HEAD']).catch(() => '');
    if (!commit) return { src };
    const dirty = (await git(srcDir, ['status', '--porcelain', '--', '.']).catch(() => '')) !== '';
    return { commit, ...(dirty && { dirty }), src };
  })());

const skipped = new Set(['issues', 'node_modules']);

/** A hub's files by path, its issues and dotfiles left out. */
const hubFiles = async (dir: string) => {
  const files: Record<string, string> = {};
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter(entry => entry.isFile())) {
    const path = relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/');
    if (path.split('/').some(part => part.startsWith('.') || skipped.has(part))) continue;
    files[path] = await readFile(join(dir, path), 'utf8');
  }
  return files;
};

const lineCounts = (text = '') =>
  text.split('\n').reduce((counts, line) => counts.set(line, (counts.get(line) ?? 0) + 1), new Map<string, number>());

/** How many lines `b` has that `a` does not, counted as a multiset. */
const linesAdded = (a: string | undefined, b: string | undefined) => {
  const before = lineCounts(a);
  let n = 0;
  for (const [line, count] of lineCounts(b)) n += Math.max(0, count - (before.get(line) ?? 0));
  return n;
};

/** `path +added -removed` for each file that differs between two versions of a hub. */
export const diffstat = (a: Record<string, string>, b: Record<string, string>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .sort()
    .filter(path => a[path] !== b[path])
    .map(
      path =>
        `${path} +${b[path] === undefined ? 0 : linesAdded(a[path], b[path])} -${a[path] === undefined ? 0 : linesAdded(b[path], a[path])}`
    );

/**
 * Versions of the hub in `dir`: each call hashes its files (see `hubFiles`) and keeps each new version's files in
 * `<data>/hubs/<hash>.json`, so a run's `hub` can be read back. Calls `changed` with the last hash, the new one and
 * the diffstat whenever the hash differs from the last call's.
 */
export const hubVersions = (
  dir: string,
  data: string,
  changed: (from: string | undefined, to: string, stat: string[]) => void
) => {
  let last: { hash: string; files: Record<string, string> } | undefined;
  return async () => {
    const files = await hubFiles(dir);
    const hash = digest(...Object.entries(files).sort().flat());
    if (hash === last?.hash) return hash;
    await mkdir(join(data, 'hubs'), { recursive: true });
    await writeFile(join(data, 'hubs', `${hash}.json`), JSON.stringify(files));
    changed(last?.hash, hash, last ? diffstat(last.files, files) : []);
    last = { hash, files };
    return hash;
  };
};
