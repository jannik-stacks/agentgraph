// One JSON line per added line in src/ that reaches a risky API: spawning processes, evaluating code, the network,
// environment reads, or removing and writing files. Each item carries the lines around it so a small model can judge
// where the input comes from.
import { readFileSync } from 'node:fs';
import { addedLines, base, changedFiles } from './changes.mjs';

const apis = [
  [/\bchild_process\b|\b(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\(/, 'a child process'],
  [/\beval\(|\bnew Function\(/, 'code evaluation'],
  [/\bfetch\(|\bnode:(net|http|https|dgram|tls)\b/, 'the network'],
  [/\bprocess\.env\b/, 'an environment read'],
  [/\b(rm|rmSync|rmdir|unlink|unlinkSync|writeFile|writeFileSync|appendFile|appendFileSync)\(/, 'a file removal or write'],
];
const around = 4;

const sha = base();
for (const { path, deleted } of changedFiles(sha)) {
  if (deleted || !/^src\/.*\.(ts|mts|js|mjs)$/.test(path)) continue;
  const lines = readFileSync(path, 'utf8').split('\n');
  for (const { line, text } of addedLines(sha, path)) {
    if (/^\s*(\/\/|\*|\/\*)/.test(text)) continue;
    const api = apis.find(([pattern]) => pattern.test(text))?.[1];
    if (!api) continue;
    const context = lines.slice(Math.max(0, line - 1 - around), line + around).join('\n');
    console.log(JSON.stringify({ file: path, line, api, code: text.trim(), context }));
  }
}
