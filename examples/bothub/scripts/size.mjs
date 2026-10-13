// Fails a change that adds more than a cap of lines, or touches more than a cap of files, outside tests/. A task
// that needs more is two tasks.
//
//   node size.mjs <max-added-lines> <max-files>      e.g. node size.mjs 300 8
import { addedLines, base, changedFiles, report } from './changes.mjs';

const [lines, files] = process.argv.slice(2).map(Number);
if (!(lines > 0 && files > 0)) throw new Error('usage: size.mjs <max-added-lines> <max-files>');

const sha = base();
const outside = changedFiles(sha).filter(({ path }) => !path.startsWith('tests/'));
const added = outside.filter(f => !f.deleted).reduce((sum, { path }) => sum + addedLines(sha, path).length, 0);

const findings = [];
if (added > lines) findings.push(`${added} added lines outside tests/, more than ${lines}; split the task`);
if (outside.length > files)
  findings.push(`${outside.length} files changed outside tests/, more than ${files}: ${outside.map(f => f.path).join(', ')}`);
report('size', findings);
