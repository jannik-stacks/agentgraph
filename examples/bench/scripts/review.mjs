// Prints one line that points the reviewer at the change, or nothing when the change is one small edit to one
// non-test file, which goes unreviewed. Any git error still prints the line, so review never silently drops.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const base = process.env.BOTHUB_BASE ?? 'HEAD';
const small = 10;
const test = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.\w+$|_test\.\w+$/;

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
const lineCount = path => {
  try {
    return readFileSync(path, 'utf8').split('\n').length;
  } catch {
    return 0;
  }
};

let files;
try {
  const tracked = git('diff', '--numstat', '--relative', base)
    .split('\n')
    .filter(Boolean)
    .map(line => line.split('\t'))
    .map(([added, removed, path]) => ({ path, lines: (Number(added) || 0) + (Number(removed) || 0) }));
  const untracked = git('ls-files', '--others', '--exclude-standard')
    .split('\n')
    .filter(Boolean)
    .map(path => ({ path, lines: lineCount(path) }));
  files = [...tracked, ...untracked];
} catch {
  console.log(`Review the change since ${base}; read it with \`git diff ${base}\`.`);
  process.exit(0);
}

const source = files.filter(f => !test.test(f.path));
if (files.length === 0 || (source.length <= 1 && source.reduce((n, f) => n + f.lines, 0) <= small)) process.exit(0);

const list = files.map(f => `${f.path} (${f.lines} lines)`).join(', ');
console.log(`Review the change since ${base}: ${list}. Read it with \`git diff ${base}\`.`);
