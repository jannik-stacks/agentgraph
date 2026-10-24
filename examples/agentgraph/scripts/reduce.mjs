// One JSON line with the brief's criteria and the lines the change adds to code and tests, each under its file and
// line number, so a reviewer can name what the criteria do not need. Each new function comes with the existing exports
// whose names share a word with it, so the reviewer can say whether one of them already does its job.
import { extname } from 'node:path';
import { findBrief, parseBrief } from './brief.mjs';
import { addedLines, readBaseShaFromEnv, baseText, changedFiles } from './changes.mjs';
import { existingExports, sharingWords } from './neighbours.mjs';

const maxChars = 40_000;
const maxHelpers = 5;
const code = new Set(['.ts', '.tsx', '.mts', '.js', '.mjs']);
const declared = /^\s*(?:export\s+)?(?:async\s+)?(?:function\*?\s+([A-Za-z_$][\w$]*)|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\(|[A-Za-z_$][\w$]*\s*=>|function\b))/;

const text = findBrief();
if (text) {
  const { task, criteria } = parseBrief(text);
  const sha = readBaseShaFromEnv();
  const files = changedFiles(sha)
    .filter(({ path, deleted }) => !deleted && code.has(extname(path)))
    .map(({ path }) => ({ path, lines: addedLines(sha, path) }));
  const added = files.flatMap(({ path, lines }) => lines.map(({ line, text }) => `${path}:${line}: ${text}`)).join('\n');
  const existing = existingExports(sha, [...[...code].map(ext => `*${ext}`), ':(exclude)*.test.*']);
  const helpers = files.flatMap(({ path, lines }) => {
    const before = baseText(sha, path) ?? '';
    return lines.flatMap(({ line, text }) => {
      const m = declared.exec(text);
      const name = m?.[1] ?? m?.[2];
      if (!name || new RegExp(`(?:function\\*?|const|let)\\s+${name.replaceAll('$', '\\$')}\\b`).test(before)) return [];
      const near = sharingWords(name, existing)
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxHelpers)
        .map(([key]) => key);
      return near.length ? [{ function: `${path}:${line}: ${text.trim().slice(0, 300)}`, existing: near }] : [];
    });
  });
  const rows = criteria.map(({ n, text, title }) => `${n}. ${text} (it('${title}'))`);
  if (added)
    console.log(
      JSON.stringify({
        path: 'change',
        task,
        'done when': rows,
        added: added.length > maxChars ? `${added.slice(0, maxChars)}\n[clipped]` : added,
        ...(helpers.length && { helpers }),
      })
    );
}
