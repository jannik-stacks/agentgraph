// One JSON line per changed file the triage brief does not name, with the task, what is out of scope and the lines
// the file gains. A file the brief names is in scope without asking anyone. Prints nothing without a brief.
import { findBrief, parseBrief } from './brief.mjs';
import { addedLines, base, changedFiles } from './changes.mjs';

const maxLines = 60;

const text = findBrief();
if (text) {
  const { task, criteria, files, outOfScope } = parseBrief(text);
  const named = new Set([...files, ...criteria.map(c => c.file)]);
  const sha = base();
  for (const { path, deleted } of changedFiles(sha)) {
    if (named.has(path)) continue;
    const added = deleted ? [] : addedLines(sha, path).map(({ text }) => text);
    const lines = added.length > maxLines ? [...added.slice(0, maxLines), '[clipped]'] : added;
    console.log(
      JSON.stringify({
        file: path,
        task,
        'out of scope': outOfScope,
        change: deleted ? 'deletes the file' : lines.join('\n'),
      })
    );
  }
}
