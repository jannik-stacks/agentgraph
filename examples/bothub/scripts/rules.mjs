// The written rules as one table over the lines a change adds: timeless comments and docs prose, words instead of
// symbols, headings that are names, no way around the hub's guards, nothing unfinished in shipped code and the current
// names for hub concepts. With `--all` every tracked line counts.
import { files, scan } from './line-rules.mjs';
import { report } from './changes.mjs';

const docsPath = /^studio\/content\/docs\/.*\.mdx?$/;
const codePath = /\.(ts|tsx|mts|cts|js|mjs)$/;
const testPath = /^tests\//;

const comments = (path, kind) => kind === 'comment' && !path.startsWith('tests/fixtures/');
const docs = (path, kind) => kind === 'prose' && docsPath.test(path);
const written = (path, kind) => comments(path, kind) || docs(path, kind);
const guarded = path =>
  /^(src|studio\/src|bin)\/.*\.(ts|tsx|mts|js|mjs)$/.test(path) ||
  /^examples\/[^/]+\/(.*\.ya?ml|workflows\/.*\.md|bots\/.*\.md|checks\/.*\.md)$/.test(path) ||
  testPath.test(path);
const shipped = path =>
  /^(src|studio\/src|bin)\/.*\.(ts|tsx|mts|js|mjs)$/.test(path) &&
  !/^src\/sim[^/]*\.ts$/.test(path) &&
  !path.startsWith('studio/src/lab/');
const named = path =>
  /^(src|studio\/src|studio\/content|bin|examples)\//.test(path) && !/^examples\/[^/]+\/(scripts|notes|fixtures)\//.test(path);

const inTests = path => testPath.test(path);
const launchers = new Set(['src/runner.ts', 'src/sim.ts']);

/** A line that quotes the old name, or names the new one beside it, is a hint about the name. */
const hint = (old, replacement) => (_, text) =>
  text.includes(replacement.replaceAll('`', '')) || new RegExp(`(===\\s*)?['"]${old}s?['"]`, 'i').test(text);
const retired = [
  [/\bexecutors?\b/i, 'executor', 'harness'],
  [/\bsouls?\b/i, 'soul', 'role'],
  [/\bpersonas?\b/i, 'persona', 'bot'],
  [/^\s*can:/, '`can:`', '`returns:`'],
  [/\bopen-pr\b/, 'open-pr', 'merge-request'],
  [/\bfor-each\b|\bforEach:/, 'for-each', '`over:`'],
  [/\bextra[ -]prompt\b/i, 'extra prompt', 'prompt'],
  [/\bnotes\/(convention|pattern)s?\b/, 'a convention or pattern note kind', 'notes/style'],
];

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
  [guarded, /push[^\n]*(--force\b|\s-f\b|--force-with-lease)/, 'a force push', inTests],
  [guarded, /@ts-(ignore|nocheck|expect-error)/, 'a silenced type error'],
  [guarded, /\bas any\b|:\s*any\b/, 'an `any` that hides a type', path => !/\.(ts|tsx|mts)$/.test(path)],
  [guarded, /\b(eslint|oxlint)-disable/, 'a silenced lint rule'],

  [shipped, /\b(TODO|FIXME|XXX|HACK)\b/, 'a marker for later; finish it or open an issue'],
  [shipped, /not (yet )?implemented|\bunimplemented\b/i, 'a path that is not implemented'],
  [shipped, /\b(fake[ds]?|stub(bed|s)?|mock(ed|s)?|dummy)\b/i, 'a fake in shipped code; build the real thing', (_, text) => /placeholder=/.test(text)],

  ...retired.map(([pattern, old, replacement]) => [named, pattern, `${old}; say ${replacement}`, hint(old, replacement)]),
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

const scanned = files(path => codePath.test(path) || /\.(mdx?|ya?ml)$/.test(path));
report('rules', [...scan(rules, scanned), ...scanned.flatMap(longBlocks)]);
