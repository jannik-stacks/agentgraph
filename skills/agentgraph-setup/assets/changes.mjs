import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';

const git = (...args) =>
  execFileSync('git', ['-c', 'core.quotePath=false', ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
const paths = text => text.split('\0').filter(Boolean);
export const base = process.env.AGENTGRAPH_BASE ?? 'HEAD';

const untracked = () =>
  paths(git('ls-files', '-z', '--others', '--exclude-standard')).filter(path => lstatSync(path).isFile());

export const touchedFiles = () => [...new Set([...paths(git('diff', '-z', '--name-only', base)), ...untracked()])];

export const existingFiles = pattern => touchedFiles().filter(file => pattern.test(file) && existsSync(file));

export const lineChanges = () => {
  const byFile = new Map();
  const entry = file => byFile.get(file) ?? byFile.set(file, { added: [], removed: [] }).get(file);
  let file = null;
  let inHunk = false;
  const diff = git('diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '-U0', base);
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      continue;
    }
    if (!inHunk && line.startsWith('+++ ')) file = line.slice(4).replace(/^b\//, '');
    if (line.startsWith('@@')) inHunk = true;
    if (!inHunk || file === '/dev/null') continue;
    if (line.startsWith('+')) entry(file).added.push(line.slice(1));
    if (line.startsWith('-')) entry(file).removed.push(line.slice(1));
  }
  for (const path of untracked()) entry(path).added.push(...readFileSync(path, 'utf8').split('\n'));
  return byFile;
};

export const report = findings => {
  if (findings.length) console.log(findings.join('\n'));
  process.exit(findings.length ? 1 : 0);
};
