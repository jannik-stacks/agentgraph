// Each criterion in the triage brief names a test title and a test file; the change must add that exact test there.
// A test titled "still …" guards behavior that already worked, so it may already be in the file.
import { readFileSync } from 'node:fs';
import { findBrief, parseBrief } from './brief.mjs';
import { addedLines, base, changedFiles, report } from './changes.mjs';

const call = /\b(it|test)(\.each\([^)]*\))?\(\s*(['"`])(.+?)\3/;

const text = findBrief();
if (!text) console.log('criteria-tests: no triage brief found for this run');
else {
  const sha = base();
  const files = new Set(changedFiles(sha).filter(f => !f.deleted).map(f => f.path));
  const lines = (file, all) => {
    if (all) {
      try {
        return readFileSync(file, 'utf8').split('\n');
      } catch {
        return [];
      }
    }
    return files.has(file) ? addedLines(sha, file).map(({ text }) => text) : [];
  };
  const findings = [];
  for (const { n, title, file } of parseBrief(text).criteria) {
    const still = title.startsWith('still ');
    if (!lines(file, still).some(line => call.exec(line)?.[4] === title))
      findings.push(`criterion ${n}: no test titled '${title}' ${still ? 'in' : 'added in'} ${file}; add it with that exact title`);
  }
  report('criteria-tests', findings);
}
