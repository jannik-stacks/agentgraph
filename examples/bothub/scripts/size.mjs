// Fails a change that adds more than a cap of lines, or touches more than a cap of files, outside tests/. A task
// that needs more is two tasks. A file whose every changed line only swaps one word for another, the same swap across
// the change, is a rename and does not count toward the file cap, so a rename is never left half done.
//
//   node size.mjs <max-added-lines> <max-files>      e.g. node size.mjs 300 8
import { addedLines, base, changedFiles, renameOf, report } from './changes.mjs';

const [lines, files] = process.argv.slice(2).map(Number);
if (!(lines > 0 && files > 0)) throw new Error('usage: size.mjs <max-added-lines> <max-files>');

const sha = base();
const outside = changedFiles(sha).filter(({ path }) => !path.startsWith('tests/'));
const added = outside.filter(f => !f.deleted).reduce((sum, { path }) => sum + addedLines(sha, path).length, 0);
const { rename, renamed } = renameOf(sha, outside);
const counted = outside.filter(({ path }) => !renamed.includes(path));

const findings = [];
if (added > lines) findings.push(`${added} added lines outside tests/, more than ${lines}; split the task`);
if (counted.length > files)
  findings.push(
    `${counted.length} files changed outside tests/${renamed.length ? ` besides ${renamed.length} that only rename ${rename}` : ''}, more than ${files}: ${counted.map(f => f.path).join(', ')}`
  );
report('size', findings);
