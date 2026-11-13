import { findBrief, parseBrief } from './brief.mjs';
import { addedLines, readEnvBaseSha, changedFiles } from './changes.mjs';

const maxLines = 60;

const text = findBrief();
if (text) {
  const { task, criteria, files, excluded } = parseBrief(text);
  const named = new Set([...files, ...criteria.map(c => c.file)]);
  const sha = readEnvBaseSha();
  for (const { path, deleted } of changedFiles(sha)) {
    if (named.has(path)) continue;
    const added = deleted ? [] : addedLines(sha, path).map(({ text }) => text);
    const lines = added.length > maxLines ? [...added.slice(0, maxLines), '[clipped]'] : added;
    console.log(
      JSON.stringify({
        file: path,
        task,
        'out of scope': excluded,
        change: deleted ? 'deletes the file' : lines.join('\n'),
      })
    );
  }
}
