// One JSON line with the brief's criteria and the lines the change adds to code and tests, each under its file and
// line number, so a reviewer can name what the criteria do not need.
import { extname } from 'node:path';
import { findBrief, parseBrief } from './brief.mjs';
import { addedLines, base, changedFiles } from './changes.mjs';

const maxChars = 40_000;
const code = new Set(['.ts', '.tsx', '.mts', '.js', '.mjs']);

const text = findBrief();
if (text) {
  const { task, criteria } = parseBrief(text);
  const sha = base();
  const added = changedFiles(sha)
    .filter(({ path, deleted }) => !deleted && code.has(extname(path)))
    .flatMap(({ path }) => addedLines(sha, path).map(({ line, text }) => `${path}:${line}: ${text}`))
    .join('\n');
  const rows = criteria.map(({ n, text, title }) => `${n}. ${text} (it('${title}'))`);
  if (added)
    console.log(
      JSON.stringify({
        path: 'change',
        task,
        'done when': rows,
        added: added.length > maxChars ? `${added.slice(0, maxChars)}\n[clipped]` : added,
      })
    );
}
