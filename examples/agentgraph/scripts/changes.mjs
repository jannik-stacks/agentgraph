// The files a change touches against $AGENTGRAPH_BASE, and the lines it adds, read with git in the worktree.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

export const readBaseShaFromEnv = () => {
  const sha = process.env.AGENTGRAPH_BASE;
  if (!sha) throw new Error('AGENTGRAPH_BASE is not set, so there is no change to check');
  git('rev-parse', '--verify', '--quiet', `${sha}^{commit}`);
  return sha;
};

const moves = new Map();

const readMoves = sha => {
  if (!moves.has(sha))
    moves.set(
      sha,
      new Map(
        git('diff', '--name-status', '--relative', '-C', sha)
          .split('\n')
          .filter(line => /^[RC]/.test(line))
          .map(line => line.split('\t').slice(1).reverse())
      )
    );
  return moves.get(sha);
};

const basePath = (sha, path) => readMoves(sha).get(path) ?? path;
const withOldPaths = (sha, paths) => paths.flatMap(path => [...new Set([basePath(sha, path), path])]);

/**
 * Changed and new files, repository-relative, with whether each one was deleted. A moved or copied file is its new
 * path, read against its old one.
 */
export const changedFiles = sha => {
  const tracked = git('diff', '--name-status', '--relative', '-C', sha)
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [status, path, moved] = line.split('\t');
      return { path: moved ?? path, deleted: status === 'D' };
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
    execFileSync('git', ['cat-file', '-e', `${sha}:./${basePath(sha, path)}`], { stdio: 'ignore' });
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
  let own = false;
  for (const row of git('diff', '-U0', '--no-color', '--relative', '-C', sha, '--', ...withOldPaths(sha, [path])).split('\n')) {
    const hunk = /^@@ -\S+ \+(\d+)(?:,\d+)? @@/.exec(row);
    if (row.startsWith('+++')) own = row === `+++ b/${path}`;
    else if (hunk) at = Number(hunk[1]);
    else if (own && row.startsWith('+')) lines.push({ line: at++, text: row.slice(1) });
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
export const baseText = (sha, path) => (inBase(sha, path) ? git('show', `${sha}:./${basePath(sha, path)}`) : undefined);

/**
 * The diff of `paths` against `sha`, with `context` lines around each change, or the whole enclosing function for
 * `'function'`. Untracked files are not in it.
 */
export const readChangeDiff = (sha, paths, context = 3) =>
  git('diff', context === 'function' ? '-W' : `-U${context}`, '--no-color', '-C', sha, '--', ...withOldPaths(sha, paths));

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

const swapCore = (before, after) => {
  let start = 0;
  let end = 0;
  while (start < Math.min(before.length, after.length) && before[start] === after[start]) start++;
  while (end < Math.min(before.length, after.length) - start && before.at(-end - 1) === after.at(-end - 1)) end++;
  return `${before.slice(start, before.length - end)} → ${after.slice(start, after.length - end)}`.toLowerCase();
};

/**
 * The one word swap every hunk of a diff makes, as `old → new`, or undefined when it changes more. Hunks compare as
 * words, so a line the swap made wrap still counts. Compound and case forms of one swap, such as `isOld → isNew`,
 * `OldError → NewError` and `OLD → NEW`, count as that swap.
 */
export const swapIn = diff => {
  const swaps = new Set();
  for (const hunk of diff.split(/^@@.*$/m).slice(1)) {
    const rows = hunk.split('\n');
    const before = rows.filter(row => row.startsWith('-')).flatMap(row => words(row.slice(1)));
    const after = rows.filter(row => row.startsWith('+')).flatMap(row => words(row.slice(1)));
    if (before.length !== after.length) return;
    for (const [i, word] of before.entries()) if (word !== after[i]) swaps.add(swapCore(word, after[i]));
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
    const whole = swapIn(`@@\n${rows.join('\n')}`) === changeRename;
    added.forEach((text, i) => {
      if (whole || (removed.length === added.length && swapIn(`@@\n-${removed[i]}\n+${text}`) === changeRename))
        renamedAt.add(at + i);
    });
  }
  return lines.filter(({ line }) => !renamedAt.has(line));
};

export const readCheckInputFiles = (wanted = () => true) => {
  if (process.argv.includes('--all'))
    return git('ls-files', '--cached', '--others', '--exclude-standard')
      .split('\n')
      .filter(path => path && wanted(path) && existsSync(path))
      .map(path => {
        const text = readFileSync(path, 'utf8');
        return { path, text, lines: text.split('\n').map((row, i) => ({ line: i + 1, text: row })) };
      });
  const sha = readBaseShaFromEnv();
  return changedFiles(sha)
    .filter(({ path, deleted }) => !deleted && wanted(path))
    .map(({ path }) => ({ path, text: readFileSync(path, 'utf8'), lines: addedLines(sha, path) }));
};
