// Fails a change that touches files outside the allowed roots, writes harness memory, adds secrets, key material, a
// huge file or a working-notes file, or changes CI.
//
//   node safety.mjs <allowed-root>... [--markdown <root>]... [--max-lines <file>:<n>]...
//
// With `--markdown`, a new markdown file must sit under one of those roots. `--max-lines` caps a file's length.
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { addedLines, base, changedFiles, inBase, report } from './changes.mjs';

const args = process.argv.slice(2);
const flag = name => {
  const values = [];
  for (let at = args.indexOf(name); at !== -1; at = args.indexOf(name)) values.push(args.splice(at, 2)[1]);
  return values;
};
const markdownRoots = flag('--markdown');
const maxLines = new Map(flag('--max-lines').map(spec => [spec.slice(0, spec.lastIndexOf(':')), Number(spec.slice(spec.lastIndexOf(':') + 1))]));
const roots = args;
if (!roots.length) throw new Error('usage: safety.mjs <allowed-root>... [--markdown <root>]... [--max-lines <file>:<n>]...');

const under = (path, root) => path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);

const forbiddenPath = [
  [/(^|\/)\.env(\.(?!example$)[^/]*)?$/, 'an environment file'],
  [/\.(pem|key|p12|pfx|keystore|jks)$/i, 'key material'],
  [/(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/, 'an SSH key'],
  [/(^|\/)\.(npmrc|netrc|git-credentials|pypirc)$/, 'a credentials file'],
  [/(^|\/)\.github\/workflows\//, 'CI configuration'],
  [/(^|\/)\.git(\/|$)/, 'git internals'],
];

const memory = [
  [/(^|\/)AGENTS\.md$/, 'AGENTS.md'],
  [/(^|\/)CLAUDE(\.local)?\.md$/, 'CLAUDE.md'],
  [/(^|\/)\.opencode\//, '.opencode/'],
];

const working = /^(audit|report|review|findings|summary|notes?|todo|unclear|deferred|progress|status|plan)([-_.].*)?\.md$/i;

const secret = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bsk-[A-Za-z0-9_-]{20,}/, 'an API key'],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/, 'a GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/, 'a GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\b(BOTHUB_LLM_API_KEY|LITELLM_MASTER_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY)\w*\s*[=:]\s*['"]?[A-Za-z0-9_-]{12,}/, 'a key assignment'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}/, 'a bearer token'],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]+:[^\s/@'"]{3,}@/i, 'a URL with credentials'],
];

/** Fixtures and vectors hold recorded ids; tests may also hold labelled test mnemonics. */
const recorded = path => /(^|\/)(fixtures|vectors)\//.test(path);
const testCode = path => recorded(path) || /(^|\/)(tests?|__tests__)\/|\.test\.[cm]?[jt]sx?$/.test(path);

/** A quoted run of 12 to 24 lowercase words on a line about a mnemonic or seed, other than the BIP-39 test vector. */
const seedPhrase = text =>
  /\b(mnemonic|seed|recovery|phrase)\b/i.test(text) &&
  [...text.matchAll(/(['"`])((?:[a-z]{3,8} ){11,23}[a-z]{3,8})\1/g)].some(m => !m[2].startsWith('abandon abandon'));

/** Bits per character of `token`. */
const entropy = token => {
  const counts = new Map();
  for (const ch of token) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / token.length) * Math.log2(n / token.length);
  return bits;
};

/** A long token of mixed case and digits as random as a generated key. Hex digests and identifiers stay below it. */
const randomToken = text =>
  (text.match(/[A-Za-z0-9+/_-]{24,}={0,2}/g) ?? []).some(
    token => /[a-z]/.test(token) && /[A-Z]/.test(token) && /\d/.test(token) && entropy(token) >= 4.2
  );

const maxBytes = 512 * 1024;
const sha = base();
const findings = [];
for (const { path, deleted } of changedFiles(sha)) {
  if (!roots.some(root => under(path, root))) findings.push(`${path}: outside the allowed paths (${roots.join(', ')})`);
  for (const [pattern, what] of forbiddenPath) if (pattern.test(path)) findings.push(`${path}: ${what} must not change`);
  for (const [pattern, what] of memory)
    if (pattern.test(path)) findings.push(`${path}: writes harness memory (${what}); propose a note instead`);
  if (deleted) continue;
  const fresh = !inBase(sha, path);
  if (fresh && statSync(path).size > maxBytes) findings.push(`${path}: a new file larger than ${maxBytes / 1024} KB`);
  if (fresh && /\.md$/.test(path) && working.test(basename(path)))
    findings.push(`${path}: a new report or tracking file; put the outcome where the project keeps its records`);
  else if (fresh && /\.mdx?$/.test(path) && markdownRoots.length && !markdownRoots.some(root => under(path, root)))
    findings.push(`${path}: a new markdown file outside ${markdownRoots.join(', ')}; keep working notes out of the repository`);
  const cap = maxLines.get(path);
  if (cap) {
    const count = readFileSync(path, 'utf8').trimEnd().split('\n').length;
    if (count >= cap) findings.push(`${path}: ${count} lines; keep it under ${cap}`);
  }
  for (const { line, text } of addedLines(sha, path)) {
    const what =
      secret.find(([pattern]) => pattern.test(text))?.[1] ||
      (!recorded(path) && randomToken(text) && 'a high-entropy token') ||
      (!testCode(path) && seedPhrase(text) && 'a seed phrase');
    if (what) findings.push(`${path}:${line}: adds ${what}`);
  }
}
report('safety', findings);
