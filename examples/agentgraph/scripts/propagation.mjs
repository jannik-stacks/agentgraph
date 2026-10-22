// Copies a rename or removal leaves behind. A name the change takes out of every file it touches, by swapping it for
// another, by deleting the line that declares it or by deleting its file, is looked up in the rest of the code, hubs
// and docs, and each place that still says it is a finding.
import { execFileSync } from 'node:child_process';
import { basename, extname } from 'node:path';
import { readFileSync } from 'node:fs';
import { base, changedFiles, diffOf, report } from './changes.mjs';

const roots = ['src', 'studio', 'docs', 'examples', 'infra', 'bin'];
const shown = 3;
const word = /[A-Za-z_$][\w$]*(?:-[\w$]+)*|\d+|\S/g;
/** A token that reads as a name rather than a word: camelCase, snake_case, kebab-case, or quoted in `row`. */
const named = (token, row) =>
  /^[A-Za-z_$][\w$-]{2,}$/.test(token) &&
  (/[a-z][A-Z]|\w[_-]\w/.test(token) || ['\'', '"', '`'].some(quote => row.includes(`${quote}${token}${quote}`)));
const declares =
  /^\s*(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:const|let|function\*?|type|interface|class|enum)\s+([A-Za-z_$][\w$]*)|^\s*['"]?([A-Za-z_$][\w$-]*)['"]?\??:/;
const comment = /^\s*(\/\/|\/\*|\*|#|$)/;
const prose = /\.mdx?$/;

const escape = token => token.replace(/[$.]/g, '\\$&');
const mentions = token => new RegExp(`(?<![\\w$-])${escape(token)}(?![\\w$-])`);

/** The names the hunks of one file's diff swap for others or stop declaring. */
const gone = (path, diff) => {
  const names = [];
  for (const hunk of diff.split(/^@@.*$/m).slice(1)) {
    const rows = hunk.split('\n');
    const keep = sign =>
      rows.filter(row => row.startsWith(sign) && !comment.test(row.slice(1))).map(row => row.slice(1));
    const removed = keep('-');
    const added = keep('+');
    for (const row of removed) {
      const [, declared, key] = declares.exec(row) ?? [];
      const name = declared ?? (prose.test(path) ? undefined : key);
      if (name && named(name, row)) names.push(name);
    }
    if (removed.length !== added.length || prose.test(path)) continue;
    removed.forEach((row, i) => {
      const before = row.match(word) ?? [];
      const after = added[i].match(word) ?? [];
      if (before.length !== after.length) return;
      names.push(...before.filter((token, j) => token !== after[j] && named(token, row)));
    });
  }
  return names;
};

/** A deleted hub file's or module's name, when it reads as a name: a check, bot, skill, script or `foo-bar.ts`. */
const stem = path => {
  const name = basename(path, extname(path));
  const hubFile = /^examples\/[^/]+\//.test(path) || named(name, '');
  return /\.(md|ts|tsx|mjs)$/.test(path) && hubFile ? [name] : [];
};

const grep = token => {
  try {
    return execFileSync('git', ['grep', '-n', '-F', '-e', token, '--', ...roots], { encoding: 'utf8' }).split('\n');
  } catch {
    return [];
  }
};

const sha = base();
const changed = changedFiles(sha).filter(({ path }) => !path.startsWith('tests/') && !/lock\.json$/.test(path));
const paths = new Set(changed.map(({ path }) => path));
const now = changed.filter(({ deleted }) => !deleted).map(({ path }) => readFileSync(path, 'utf8'));
const candidates = new Map();
for (const { path, deleted } of changed) {
  const names = deleted ? stem(path) : gone(path, diffOf(sha, [path], 0));
  for (const name of names) if (!candidates.has(name)) candidates.set(name, path);
}

const findings = [];
for (const [token, from] of candidates) {
  const mention = mentions(token);
  if (now.some(text => mention.test(text))) continue;
  const left = grep(token).filter(row => {
    const [, file, text] = /^([^:]+):\d+:(.*)$/.exec(row) ?? [];
    return file && !paths.has(file) && mention.test(text);
  });
  if (!left.length) continue;
  const where = left.slice(0, shown).map(row => row.split(':').slice(0, 2).join(':'));
  const more = left.length > shown ? ` and ${left.length - shown} more` : '';
  const verb = left.length === 1 ? 'says' : 'say';
  findings.push(`${token}: the change takes it out of ${from}, but ${where.join(', ')}${more} still ${verb} it`);
}
report('propagation', findings);
