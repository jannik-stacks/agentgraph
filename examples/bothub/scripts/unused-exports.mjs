// An export a change adds under src/ or studio/src that no other file uses: code nobody needs yet.
import { execFileSync } from 'node:child_process';
import { addedLines, base, changedFiles, report } from './changes.mjs';

const declaration =
  /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|function\*?|type|interface|class|enum)\s+([A-Za-z_$][\w$]*)/;
const code = /^(src|studio\/src)\/.*\.(ts|tsx|mts)$/;

const users = name => {
  try {
    return execFileSync('git', ['grep', '-l', '--untracked', '-w', '-F', name, '--', 'src', 'studio', 'bin', 'tests'], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
};

const sha = base();
const findings = [];
for (const { path, deleted } of changedFiles(sha)) {
  if (deleted || !code.test(path)) continue;
  for (const { line, text } of addedLines(sha, path)) {
    const name = declaration.exec(text)?.[1];
    if (name && !users(name).some(user => user !== path)) {
      findings.push(`${path}:${line}: ${name} is exported but no other file uses it; drop the export or the code`);
    }
  }
}
report('unused-exports', findings);
