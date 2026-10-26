// The files a change touches against $AGENTGRAPH_BASE, and the lines it adds, read with git in the worktree.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

export const readBaseShaFromEnv = () => {
  const sha = process.env.AGENTGRAPH_BASE;
  if (!sha) throw new Error('AGENTGRAPH_BASE is not set, so there is no change to check');
  git('rev-parse', '--verify', '--quiet', `${sha}^{commit}`);
  return sha;
};

/** Changed and new files, repository-relative, with whether each one was deleted. */
export const changedFiles = sha => {
  const tracked = git('diff', '--name-status', '--relative', '--no-renames', sha)
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [status, path] = line.split('\t');
      return { path, deleted: status === 'D' };
    });
  const untracked = git('ls-files', '--others', '--exclude-standard')
    .split('\n')
    .filter(Boolean)
    .map(path => ({ path, deleted: false }));
  return [...tracked, ...untracked];
};

/** Whether `path` exists in the commit `sha`. */
export const inBase = (sha, path) => {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}:./${path}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/** The lines a file gains, with their line numbers in the new version. A new file gains all of its lines. */
export const addedLines = (sha, path) => {
  if (!inBase(sha, path)) {
    if (statSync(path).size > 2 * 1024 * 1024) return [];
    return readFileSync(path, 'utf8')
      .replace(/\n$/, '')
      .split('\n')
      .map((text, i) => ({ line: i + 1, text }));
  }
  const lines = [];
  let at = 0;
  for (const row of git('diff', '-U0', '--no-color', sha, '--', path).split('\n')) {
    const hunk = /^@@ -\S+ \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) at = Number(hunk[1]);
    else if (row.startsWith('+') && !row.startsWith('+++')) lines.push({ line: at++, text: row.slice(1) });
  }
  return lines;
};

/** Prints the findings and exits non-zero when there are any. */
export const report = (name, findings) => {
  if (!findings.length) {
    console.log(`${name}: ok`);
    return;
  }
  for (const finding of findings) console.log(finding);
  console.log(`${name}: ${findings.length} finding${findings.length === 1 ? '' : 's'}`);
  process.exitCode = 1;
};

/** A file's text in the commit `sha`, or `undefined` when it does not exist there. */
export const baseText = (sha, path) => (inBase(sha, path) ? git('show', `${sha}:./${path}`) : undefined);

/**
 * The diff of `paths` against `sha`, with `context` lines around each change, or the whole enclosing function for
 * `'function'`. Untracked files are not in it.
 */
export const readChangeDiff = (sha, paths, context = 3) =>
  git('diff', context === 'function' ? '-W' : `-U${context}`, '--no-color', '--no-renames', sha, '--', ...paths);

/** A vitest test file. */
export const isTestFile = path => /^tests\/.*\.test\.(ts|tsx|mts|js|mjs)$/.test(path);

const call = /\b(it|test)(\.each\([^)]*\))?\(\s*(['"`])(.+?)\3/;

/** The title of the `it` or `test` call that starts on `line`, if one does. */
export const parseTestCallTitle = line => call.exec(line)?.[4];

/** The change under `roots` as one diff text, new untracked files included as added lines. */
export const changeText = (sha, roots, context = 3) => {
  const files = changedFiles(sha).filter(({ path }) => roots.some(root => path.startsWith(root)));
  const tracked = files.filter(({ path }) => inBase(sha, path) || git('ls-files', path).trim());
  const fresh = files.filter(f => !f.deleted && !tracked.includes(f));
  const diff = tracked.length ? readChangeDiff(sha, tracked.map(f => f.path), context) : '';
  const added = fresh.map(({ path }) => {
    const lines = addedLines(sha, path).map(({ text }) => `+${text}`);
    return `diff --git a/${path} b/${path}\nnew file\n+++ b/${path}\n${lines.join('\n')}`;
  });
  return [diff.trimEnd(), ...added].filter(Boolean).join('\n');
};

const words = text => text.match(/\w+|[^\w\s]/g) ?? [];

/** The one word swap every changed line of a diff makes, as `old → new`, or undefined when it changes more. */
export const swapIn = diff => {
  const swaps = new Set();
  for (const hunk of diff.split(/^@@.*$/m).slice(1)) {
    const rows = hunk.split('\n');
    const removed = rows.filter(row => row.startsWith('-')).map(row => words(row.slice(1)));
    const added = rows.filter(row => row.startsWith('+')).map(row => words(row.slice(1)));
    if (removed.length !== added.length) return;
    for (const [i, before] of removed.entries()) {
      const after = added[i];
      if (before.length !== after.length) return;
      for (const [j, word] of before.entries()) if (word !== after[j]) swaps.add(`${word} → ${after[j]}`);
    }
  }
  return swaps.size === 1 ? [...swaps][0] : undefined;
};

/** The change's rename: the swap the most of `files` make with every line they change, and those files. */
export const findDominantTokenRename = (sha, files) => {
  const swaps = new Map();
  for (const { path, deleted } of files) {
    const swap = !deleted && inBase(sha, path) ? swapIn(readChangeDiff(sha, [path], 0)) : undefined;
    if (swap) swaps.set(swap, [...(swaps.get(swap) ?? []), path]);
  }
  const [rename, renamed = []] = [...swaps].sort((a, b) => b[1].length - a[1].length)[0] ?? [];
  return { rename, renamed };
};

let changeRename;

/**
 * The lines a file gains that do more than the change's rename. A line whose only difference from the line it
 * replaces is that swap was there before, so a check that blames new code leaves it alone.
 */
export const ownLines = (sha, path) => {
  changeRename ??= findDominantTokenRename(sha, changedFiles(sha)).rename;
  const lines = addedLines(sha, path);
  if (!changeRename || !inBase(sha, path)) return lines;
  const renamedAt = new Set();
  for (const hunk of readChangeDiff(sha, [path], 0).split(/^(?=@@ )/m).slice(1)) {
    const at = Number(/^@@ -\S+ \+(\d+)/.exec(hunk)?.[1] ?? 0);
    const rows = hunk.split('\n').slice(1);
    const removed = rows.filter(row => row.startsWith('-')).map(row => row.slice(1));
    const added = rows.filter(row => row.startsWith('+')).map(row => row.slice(1));
    if (removed.length !== added.length) continue;
    added.forEach((text, i) => {
      if (swapIn(`@@\n-${removed[i]}\n+${text}`) === changeRename) renamedAt.add(at + i);
    });
  }
  return lines.filter(({ line }) => !renamedAt.has(line));
};

