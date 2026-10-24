// A schema a change adds to src/hub.ts that no docs page names, so the reference falls behind the code.
import { execFileSync } from 'node:child_process';
import { addedLines, readBaseShaFromEnv, changedFiles, report } from './changes.mjs';

const declaration = /^export const ([A-Z]\w*)\s*=\s*Schema\b/;

const mentioned = name => {
  try {
    execFileSync('git', ['grep', '-q', '--untracked', '-w', '-F', name, '--', 'docs'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const sha = readBaseShaFromEnv();
const findings = [];
for (const { path, deleted } of changedFiles(sha)) {
  if (deleted || path !== 'src/hub.ts') continue;
  for (const { line, text } of addedLines(sha, path)) {
    const name = declaration.exec(text)?.[1];
    if (name && !mentioned(name)) {
      findings.push(`${path}:${line}: ${name} is in no docs page; name it where it belongs, as "See \`${name}\` in src/hub.ts"`);
    }
  }
}
report('docs-sync', findings);
