// What a change adds under src/ or studio/src that nothing wires in: an export no other file uses, a new file nothing
// outside tests imports, a new optional field nothing outside tests sets, and a new event type nothing outside tests
// reads. Fields and events are matched by words, so they only fail when no line could be the use.
import { execFileSync } from 'node:child_process';
import { basename, extname } from 'node:path';
import { ownLines, readBaseShaFromEnv, changedFiles, inBase, report } from './changes.mjs';

const declaration =
  /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|function\*?|type|interface|class|enum)\s+([A-Za-z_$][\w$]*)/;
const code = /^(src|studio\/src)\/.*\.(ts|tsx|mts)$/;
const optionalField = /(?:^\s*|[{;]\s*)([A-Za-z_$][\w$]*)\?:/g;
const eventType = /\btype: '([\w-]+)';/;

/** Lines that match `pattern` in the code and tests, as `{ file, line, text }`. */
const hits = (pattern, ...flags) => {
  try {
    return execFileSync('git', ['grep', '-n', '--untracked', ...flags, '-e', pattern, '--', 'src', 'harnesses', 'agentgraph.config.ts', 'studio', 'bin', 'tests'], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .map(row => {
        const [, file, line, text] = /^([^:]+):(\d+):(.*)$/.exec(row);
        return { file, line: Number(line), text };
      });
  } catch {
    return [];
  }
};
/** A hit outside tests and outside `path`, or with `line`, outside that one line. */
const elsewhere = (path, line) => hit =>
  !hit.file.startsWith('tests/') && (hit.file !== path || (line !== undefined && hit.line !== line));

const sha = readBaseShaFromEnv();
const findings = [];
for (const { path, deleted } of changedFiles(sha)) {
  if (deleted || !code.test(path)) continue;
  const stem = basename(path, extname(path)).replace(/[.$]/g, '\\$&');
  if (!inBase(sha, path) && !hits(`['"][^'"]*/${stem}(\\.m?[jt]sx?)?['"]`, '-E').some(elsewhere(path)))
    findings.push(`${path}: a new file nothing outside tests imports; call it from the code that needs it`);
  for (const { line, text } of ownLines(sha, path)) {
    const name = declaration.exec(text)?.[1];
    if (name && !hits(name, '-w', '-F').some(hit => hit.file !== path))
      findings.push(`${path}:${line}: ${name} is exported but no other file uses it; drop the export or the code`);
    for (const [, field] of text.trimEnd().endsWith(',') ? [] : text.matchAll(optionalField)) {
      const set = `(^|[^.?[:alnum:]_$])${field}[[:space:]]*:|\\.${field}[[:space:]]*=[^=]|[{,][[:space:]]*${field}[[:space:]]*[,}]|^[[:space:]]*${field},?$`;
      if (!hits(set, '-E').some(elsewhere(path, line)))
        findings.push(`${path}:${line}: ${field} is a new optional field nothing outside tests sets; set it where the value is made, or drop it`);
    }
    const kind = eventType.exec(text)?.[1];
    const reads = kind && hits(`'${kind}'|(^|[{,[:space:]])${kind}[[:space:]]*:`, '-E');
    if (kind && !reads.filter(hit => !hit.text.includes(`type: '${kind}'`)).some(elsewhere(path, line)))
      findings.push(`${path}:${line}: '${kind}' is a new event type nothing outside tests reads; handle it where events are read, or drop it`);
  }
}
report('unused-exports', findings);
