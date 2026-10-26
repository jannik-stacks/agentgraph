import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addedLines, changedFiles, readBaseShaFromEnv, report } from './changes.mjs';

const home =
  /\/Users\/(?!(?:me|you|YOUR-USER|USER|Shared)\b)[\w.-]+|\/home\/(?!(?:me|you|node|user|agent|auth|runner|USER)\b)[a-z][\w.-]*|\/private\/tmp\//;
const email =
  /(?<![\w.%+-])(?!git@|[\w.%+-]*no-?reply[\w.%+-]*@)[\w.%+-]+@(?!(?:[\w-]+\.)*(?:example\.(?:com|org|net)|noreply\.github\.com)\b)(?![\w.-]+\.(?:invalid|internal|test|example|localhost|local)\b)[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/i;

const listed = process.env.AGENTGRAPH_DENY || join(process.env.AGENTGRAPH_DIR ?? join(import.meta.dirname, '..'), 'deny.txt');
const findings = [];
if (process.env.AGENTGRAPH_DENY && !existsSync(listed)) findings.push('AGENTGRAPH_DENY names no file');
const deny = existsSync(listed)
  ? readFileSync(listed, 'utf8')
      .split('\n')
      .flatMap((line, i) =>
        line.trim() && !line.startsWith('#') ? [[new RegExp(line.trim(), 'i'), `a word on line ${i + 1} of the deny list`]] : []
      )
  : [];

const rules = [[home, 'a home folder path'], [email, 'an email address that is not a noreply one'], ...deny];
const hits = text => rules.filter(([pattern]) => pattern.test(text)).map(([, why]) => why);
const strings = value =>
  typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];

const proposals = process.env.AGENTGRAPH_PROPOSALS ? JSON.parse(readFileSync(process.env.AGENTGRAPH_PROPOSALS, 'utf8')) : [];
for (const p of proposals) for (const why of new Set(strings(p).flatMap(hits))) findings.push(`${p.kind} proposal: names ${why}`);

if (process.env.AGENTGRAPH_BASE) {
  const sha = readBaseShaFromEnv();
  for (const { path, deleted } of changedFiles(sha)) {
    if (deleted) continue;
    for (const why of hits(path)) findings.push(`${path}: its path names ${why}`);
    for (const { line, text } of addedLines(sha, path)) for (const why of hits(text)) findings.push(`${path}:${line}: adds ${why}`);
  }
}
report('hygiene', findings);
