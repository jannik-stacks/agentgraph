// Fails a change that adds more than a cap of lines, or adds to or changes more than a cap of files, outside tests/.
// A task that needs more is two tasks. A file that only deletes lines does not count toward the file cap. A file
// whose every changed line only swaps one word for another, the same swap across the change, is a rename and does
// not count either, so a rename is never left half done. The caps are the ones in bounds.mjs unless given.
//
//   node size.mjs [<max-added-lines> <max-files>]      e.g. node size.mjs 300 8
import { capped, maxAddedLines, maxFiles } from './bounds.mjs';
import { addedLines, readBaseShaFromEnv, changedFiles, findDominantTokenRename, report } from './changes.mjs';

const given = process.argv.slice(2).map(Number);
const [lines, files] = given.length ? given : [maxAddedLines, maxFiles];
if (!(lines > 0 && files > 0)) throw new Error('usage: size.mjs [<max-added-lines> <max-files>]');

const sha = readBaseShaFromEnv();
const outside = changedFiles(sha)
  .filter(({ path, deleted }) => capped(path) && !deleted)
  .map(file => ({ ...file, added: addedLines(sha, file.path).length }))
  .filter(({ added }) => added > 0);
const added = outside.reduce((sum, file) => sum + file.added, 0);
const { rename, renamed } = findDominantTokenRename(sha, outside);
const counted = outside.filter(({ path }) => !renamed.includes(path));

const findings = [];
if (added > lines) findings.push(`${added} added lines outside tests/, more than ${lines}; split the task`);
if (counted.length > files)
  findings.push(
    `${counted.length} files changed outside tests/${renamed.length ? ` besides ${renamed.length} that only rename ${rename}` : ''}, more than ${files}: ${counted.map(f => f.path).join(', ')}`
  );
report('size', findings);
