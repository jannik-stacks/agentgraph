import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

if (process.argv.includes('--help')) {
  console.log(
    `usage: node scan-private.mjs <dir-or-file>... [--deny <file>]\n\nA heuristic, not proof: also read the diff. Fails when files about to be committed hold something private: a home path, an email other than a noreply one, a key-like string, a private key block, or a word from a deny list (one per line: names, hosts, internal URLs; --deny or AGENTGRAPH_DENY).`
  );
  process.exit(0);
}

const { values, positionals } = parseArgs({ allowPositionals: true, options: { deny: { type: 'string' } } });
if (!positionals.length) {
  console.error('usage: node scan-private.mjs <dir-or-file>... [--deny <file>]');
  process.exit(2);
}
const denyFile = values.deny ?? process.env.AGENTGRAPH_DENY;
if (denyFile && !existsSync(denyFile)) {
  console.error(`deny list ${denyFile} does not exist`);
  process.exit(2);
}
const denied = denyFile
  ? readFileSync(denyFile, 'utf8')
      .split('\n')
      .map(w => w.trim().toLowerCase())
      .filter(w => w && !w.startsWith('#'))
  : [];
const escape = word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rules = [
  [new RegExp(escape(homedir())), 'your home folder'],
  [/(^|[\s'"`(=:])\/(Users|home)\/[^/\s'"`]+|[A-Za-z]:\\Users\\[^\\\s]+/, 'a home folder path'],
  [/[\w.+-]+@(?!users\.noreply\.github\.com\b|noreply\b)[\w-]+\.[a-z]{2,}\b/i, 'an email address'],
  [
    /\b(sk-[\w-]{16,}|gh[pousr]_\w{20,}|github_pat_\w{20,}|xox[abpr]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})\b/,
    'a key-like string',
  ],
  [/\bBearer\s+[\w.~+/-]{16,}/, 'a bearer token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/(api[_-]?key|secret|token|passw(or)?d)['"]?\s*[:=]\s*['"]?[^\s'"]{12,}/i, 'a credential assignment'],
];
const findings = [];
const walk = path => {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return findings.push(`${path}: a symlink; agentgraph refuses links in a graph`) && [];
  return stat.isDirectory() ? readdirSync(path).flatMap(name => walk(join(path, name))) : [path];
};
for (const file of positionals.flatMap(walk)) {
  if (lstatSync(file).size > 2 << 20) {
    findings.push(`${file}: over 2 MB, not scanned; a graph file that big needs a look by hand`);
    continue;
  }
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((text, i) => {
      for (const [pattern, what] of rules) if (pattern.test(text)) findings.push(`${file}:${i + 1}: ${what}`);
      for (const word of denied)
        if (text.toLowerCase().includes(word)) findings.push(`${file}:${i + 1}: the denied word "${word}"`);
    });
}
console.log(
  findings.length ? findings.join('\n') : 'nothing private found by these patterns; read the diff yourself too'
);
process.exit(findings.length ? 1 : 0);
