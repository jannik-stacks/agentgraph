// Fails a change that touches files outside the allowed roots, adds secrets or key material, or adds a huge file.
//
//   node safety.mjs <allowed-root>...      e.g. node safety.mjs kit/ docs/
import { statSync } from 'node:fs';
import { addedLines, base, changedFiles, inBase, report } from './changes.mjs';

const roots = process.argv.slice(2);
if (!roots.length) throw new Error('usage: safety.mjs <allowed-root>...');

const forbiddenPath = [
  [/(^|\/)\.env(\.(?!example$)[^/]*)?$/, 'an environment file'],
  [/\.(pem|key|p12|pfx|keystore|jks)$/i, 'key material'],
  [/(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/, 'an SSH key'],
  [/(^|\/)\.(npmrc|netrc|git-credentials|pypirc)$/, 'a credentials file'],
  [/(^|\/)\.github\/workflows\//, 'CI configuration'],
  [/(^|\/)\.git(\/|$)/, 'git internals'],
];

const secret = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bsk-[A-Za-z0-9_-]{20,}/, 'an API key'],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/, 'a GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/, 'a GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\b(BOTHUB_LLM_API_KEY|LITELLM_MASTER_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY)\w*\s*[=:]\s*['"]?[A-Za-z0-9_-]{12,}/, 'a key assignment'],
];

const maxBytes = 512 * 1024;
const sha = base();
const findings = [];
for (const { path, deleted } of changedFiles(sha)) {
  if (!roots.some(root => path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)))
    findings.push(`${path}: outside the allowed paths (${roots.join(', ')})`);
  for (const [pattern, what] of forbiddenPath) if (pattern.test(path)) findings.push(`${path}: ${what} must not change`);
  if (deleted) continue;
  if (!inBase(sha, path) && statSync(path).size > maxBytes) findings.push(`${path}: a new file larger than ${maxBytes / 1024} KB`);
  for (const { line, text } of addedLines(sha, path))
    for (const [pattern, what] of secret) if (pattern.test(text)) findings.push(`${path}:${line}: adds ${what}`);
}
report('safety', findings);
