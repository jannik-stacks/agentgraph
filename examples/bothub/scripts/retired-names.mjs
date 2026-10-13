// Names the project replaced, anywhere a change adds them: code, docs and hub files. A line that quotes the old name
// or names the new one beside it is talking about the name, as a hint or a rule does, and stays allowed.
import { scan } from './line-rules.mjs';

const wanted = path =>
  /^(src|studio\/src|studio\/content|bin|examples)\//.test(path) && !/^examples\/[^/]+\/(scripts|notes)\//.test(path);

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

const hint = (old, replacement) => (_, text) =>
  !text.includes(replacement.replaceAll('`', '')) && !new RegExp(`(===\\s*)?['"]${old}s?['"]`, 'i').test(text);

scan(
  'retired-names',
  wanted,
  retired.map(([pattern, old, replacement]) => [pattern, `${old}; say ${replacement}`, hint(old, replacement)])
);
