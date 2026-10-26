// The written rules as one table over the lines a change adds: timeless comments and docs prose, words instead of
// symbols, headings that are names, ASCII diagram arrows, safe git ranges and refs, no way around the hub's guards,
// nothing unfinished in shipped code, current names and no CLAUDE.md. With `--all` every tracked line counts.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scan } from './line-rules.mjs';
import { readCheckInputFiles, report } from './changes.mjs';

const retiredPaths = [
  join(process.cwd(), 'src/retired.ts'),
  fileURLToPath(new URL('../../../src/retired.ts', import.meta.url)),
];
const { formatRetiredAdvice, retiredWords } = await import(pathToFileURL(retiredPaths.find(existsSync)).href);

const docsPath = /^docs\/.*\.mdx?$/;
const codePath = /\.(ts|tsx|mts|cts|js|mjs)$/;
const testPath = /^tests\//;

const comments = (path, kind) => kind === 'comment' && !path.startsWith('tests/fixtures/');
const docs = (path, kind) => kind === 'prose' && docsPath.test(path);
const written = (path, kind) => comments(path, kind) || docs(path, kind);
const guarded = path =>
  /^(src|studio\/src|bin)\/.*\.(ts|tsx|mts|js|mjs)$/.test(path) ||
  /^examples\/[^/]+\/(.*\.ya?ml|workflows\/.*\.md|agents\/.*\.md|checks\/.*\.md)$/.test(path) ||
  testPath.test(path);
const shipped = path =>
  /^(src|studio\/src|bin)\/.*\.(ts|tsx|mts|js|mjs)$/.test(path) &&
  !/^src\/sim[^/]*\.ts$/.test(path) &&
  !path.startsWith('studio/src/lab/');
const named = path =>
  /^(src|studio\/src|docs|bin|examples)\//.test(path) && !/^examples\/[^/]+\/(scripts|notes|fixtures)\//.test(path);

const inTests = path => testPath.test(path);
const kept = path => !path.startsWith('research/');
const diagram = (path, kind) => kept(path) && kind === 'fence' && /\.mdx?$/.test(path);
const launchers = new Set(['src/runner.ts', 'src/sim.ts']);

/** A line that quotes the old name, or names the new one beside it, is a hint about the name. */
const hint = ({ word, example }) => (_, text) =>
  (example !== undefined && text.includes(example.replaceAll('`', ''))) ||
  new RegExp(`(===\\s*)?['"]${word}s?['"]`, 'i').test(text);

const rules = [
  [written, /\b20\d\d-\d\d-\d\d\b/, 'a date'],
  [written, /\bMorgan\b/, 'a name'],
  [written, /·/, 'a middle dot separator; use a comma, "and" or an em dash'],
  [written, /[⊃⊂∘‖≡⇄↔]/, 'a math or logic symbol; write the words instead'],
  [written, /\binert\b/i, 'the word "inert"'],
  [comments, /\b(decision|record|ruling)\s+#?\d{2,4}\b|\bruled\b|\bruling\b/i, 'a ruling or decision reference in a comment'],
  [comments, /\b(renamed (from|to)|formerly|previously called|used to be|no longer)\b/i, 'history in a comment'],
  [docs, /\b(as )?(requested|suggested|asked) by\b/i, 'an attribution'],
  [docs, /\bresearch\/\d+|\bdecision\s+#?\d{2,4}\b|\b[DQPC]-\d{2,3}\b/, 'an internal reference; link the page instead'],
  [docs, /\b(we|I) (decided|changed|renamed|used to)\b|\b(renamed (from|to)|formerly|previously|no longer)\b/i, 'history; say what it does now'],
  [
    docs,
    /\b(centerpiece|honest(ly)?|game[- ]changer|seamless(ly)?|revolutionary|delve|leverag(e|es|ing)|robust|comprehensive|crucial|powerful|effortless(ly)?|elevate|unlock|empower)\b|\bthe real story\b/i,
    'a marketing or filler word',
  ],
  [docs, /\b(it'?s worth noting|in summary|in conclusion|at its core|simply put)\b/i, 'a filler phrase'],
  [docs, /^#{1,6}\s+(?![A-Z]-\d+ — ).* [—–] /, 'a heading with an em-dash suffix; a heading is a name'],
  [docs, /^#{1,6}\s+(?![A-Z]-\d+ — )(?:[^`]*\w: |.*:\s*$)/, 'a heading with a colon prefix or suffix'],
  [
    docs,
    /<Source\b[^>]*\bfile="[^"]+\.(ts|tsx|mts)"/,
    '<Source> shows a whole file; show the symbol it is about',
    (_, text) => /\b(symbol|region|lines)=/.test(text),
  ],

  [guarded, /\ballow[-_]?skip|\bskip[-_]?checks?\b|\ballowSkip|\bskipChecks/i, 'a way to skip checks; a check that is not needed is removed', inTests],
  [guarded, /--dangerously|dangerouslySkip|bypassPermissions|--yolo\b|--auto-approve/, 'a harness that approves its own tool calls', inTests],
  [guarded, /\bsandbox\s*[:=]\s*['"]?(none|off|false|disabled)\b/i, 'the sandbox switched off; it fails closed instead', inTests],
  [guarded, /\bunsandboxed\b/, 'the unsandboxed launcher outside the runner and the simulator', path => inTests(path) || launchers.has(path)],
  [
    guarded,
    /push[^\n]*(--force\b|\s-f\b|--force-with-lease)/,
    'a force push',
    (path, text) => inTests(path) || (path.startsWith('src/') && !/--force(?![-\w])|\s-f\b|--force-with-lease(?!=[^\s:]+:)/.test(text)),
  ],
  [guarded, /@ts-(ignore|nocheck|expect-error)/, 'a silenced type error'],
  [guarded, /\bas any\b|:\s*any\b|<any[>,]|,\s*any>|=\s*any\s*;|ReturnType<typeof JSON\.parse>/, 'an `any` that hides a type', path => !/\.(ts|tsx|mts)$/.test(path)],
  [guarded, /\b(eslint|oxlint)-disable/, 'a silenced lint rule'],

  [shipped, /\b(TODO|FIXME|XXX|HACK)\b/, 'a marker for later; finish it or open an issue'],
  [shipped, /not (yet )?implemented|\bunimplemented\b/i, 'a path that is not implemented'],
  [shipped, /\b(fake[ds]?|stub(bed|s)?|mock(ed|s)?|dummy)\b/i, 'a fake in shipped code; build the real thing', (_, text) => /placeholder=/.test(text)],

  [diagram, /[►◄▲▼▶◀→←↑↓⟶⟵⇒⇐]/, 'a unicode arrow in a fenced block; diagram arrow heads are ASCII > < v ^'],
  [path => kept(path) && !inTests(path), /\bgit diff\b[^\n]*[^.\s]\.\.HEAD\b/, 'a two-dot range to HEAD; review a branch with base...HEAD'],

  ...retiredWords
    .filter(({ text }) => text)
    .map(retired => [named, retired.text, `${retired.word}; ${formatRetiredAdvice(retired)}`, hint(retired)]),
];

const longest = 30;

/** A fenced code block longer than `longest` lines that the change opens on a docs page. */
const longBlocks = ({ path, text, lines }) => {
  if (!docsPath.test(path)) return [];
  const added = new Set(lines.map(({ line }) => line));
  const found = [];
  let open;
  text.split('\n').forEach((row, i) => {
    if (!/^\s*(```|~~~)/.test(row)) return;
    if (open === undefined) open = i;
    else {
      const length = i - open - 1;
      if (length > longest && added.has(open + 1))
        found.push(`${path}:${open + 1}: a ${length}-line code block; show an excerpt, or a <Source> symbol`);
      open = undefined;
    }
  });
  return found;
};

/** A check the change adds in block or stop mode whose body names no replay that calibrated it. */
const uncalibrated = ({ path, text, lines }) => {
  const [, front = '', ...body] = text.split(/^---\s*$/m);
  const fresh = lines.length === text.replace(/\n$/, '').split('\n').length;
  const unproven = /^mode:\s*(block|stop)\b/m.test(front) && !/\b(calibrat|replay)/i.test(body.join('---'));
  if (!/^examples\/[^/]+\/checks\/[^/]+\.md$/.test(path) || !fresh || !unproven) return [];
  return [`${path}:1: a new check in block or stop mode with no calibration; start it in warn mode, or say in its body which replay calibrated it`];
};

const readArrayItems = (text, from) => {
  const token = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|[^]/y;
  token.lastIndex = from;
  const items = [];
  let depth = 0;
  let item = '';
  for (let match = token.exec(text); match; match = token.exec(text)) {
    const [part] = match;
    if (depth === 0 && (part === ',' || part === ']')) {
      items.push(item.trim());
      item = '';
      if (part === ']') return { items: items.filter(Boolean), end: token.lastIndex };
      continue;
    }
    if ('([{'.includes(part)) depth++;
    if (')]}'.includes(part)) depth--;
    item += part;
  }
};

const lineAt = (text, offset) => text.slice(0, offset).split('\n').length;

const unguardedRefUpdates = ({ path, text, lines }) => {
  if (!/^src\/.*\.ts$/.test(path)) return [];
  const added = lines.map(({ line }) => line);
  return [...text.matchAll(/'update-ref'\s*,/g)].flatMap(match => {
    const array = readArrayItems(text, match.index + match[0].length);
    if (!array || array.items.some(item => item.startsWith('...'))) return [];
    const [first, last] = [lineAt(text, match.index), lineAt(text, array.end)];
    if (!added.some(line => line >= first && line <= last)) return [];
    const operands = array.items.filter((item, i) => !item.startsWith("'-") && array.items[i - 1] !== "'-m'");
    if (operands.length >= (array.items.includes("'-d'") ? 2 : 3)) return [];
    return [`${path}:${first}: update-ref without the expected old sha; pass it so a concurrent move fails`];
  });
};

const claudeFile = ({ path }) =>
  kept(path) && /(^|\/)CLAUDE\.md$/.test(path) ? [`${path}:1: a CLAUDE.md file; agent instructions live in AGENTS.md only`] : [];

const scanned = readCheckInputFiles(path => codePath.test(path) || /\.(mdx?|ya?ml|sh)$/.test(path));
const fileRules = [longBlocks, uncalibrated, unguardedRefUpdates, claudeFile];
report('rules', [...scan(rules, scanned), ...fileRules.flatMap(rule => scanned.flatMap(rule))]);
