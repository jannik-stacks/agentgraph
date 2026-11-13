import { execFileSync } from 'node:child_process';
import { addedLines, readEnvBaseSha, changedFiles, report } from './changes.mjs';

const formats = new Set(['src/folder.ts', 'src/workflow.ts', 'src/result.ts', 'src/proposal.ts', 'src/settings.ts']);
const declaration = /^export const ([A-Z]\w*)\s*=\s*Schema\b/;

const mentioned = name => {
  try {
    execFileSync('git', ['grep', '-q', '--untracked', '-w', '-F', name, '--', 'docs'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const sha = readEnvBaseSha();
const findings = [];
for (const { path, deleted } of changedFiles(sha)) {
  if (deleted || !formats.has(path)) continue;
  for (const { line, text } of addedLines(sha, path)) {
    const name = declaration.exec(text)?.[1];
    if (name && !mentioned(name)) {
      findings.push(`${path}:${line}: ${name} is in no docs page; name it where it belongs, as "See \`${name}\` in ${path}"`);
    }
  }
}
report('docs-sync', findings);
