import type { ReactNode } from 'react';

const tint = {
  key: 'text-sky-700 dark:text-sky-300',
  string: 'text-emerald-700 dark:text-emerald-300',
  literal: 'text-amber-700 dark:text-amber-300',
  comment: 'text-zinc-400 dark:text-zinc-500 italic',
  heading: 'text-violet-700 dark:text-violet-300 font-semibold',
  punct: 'text-zinc-400 dark:text-zinc-500',
  code: 'text-rose-700 dark:text-rose-300',
};
type Tint = keyof typeof tint;
type Token = [text: string, tint?: Tint];
type Lexer = (line: string, state: { fenced: boolean }) => Token[];

const splitComment = (text: string, marker: RegExp): [string, string] => {
  const match = marker.exec(text);
  return match ? [text.slice(0, match.index), text.slice(match.index)] : [text, ''];
};

const value = (text: string): Token => {
  const trimmed = text.trim();
  if (/^(["']).*\1$/.test(trimmed)) return [text, 'string'];
  if (/^(true|false|null|~|-?\d+(\.\d+)?)$/.test(trimmed)) return [text, 'literal'];
  return [text];
};

const yaml: Lexer = line => {
  const [code, comment] = splitComment(line, /(^|\s)#.*/);
  const tokens: Token[] = [];
  const key = /^(\s*(?:-\s+)?)([^\s:#][^:#]*?)(:)(?=\s|$)(.*)$/.exec(code);
  if (key) tokens.push([key[1] ?? ''], [key[2] ?? '', 'key'], [':', 'punct'], value(key[4] ?? ''));
  else {
    const item = /^(\s*-)(\s.*|)$/.exec(code);
    if (item) tokens.push([item[1] ?? '', 'punct'], value(item[2] ?? ''));
    else tokens.push(value(code));
  }
  if (comment) tokens.push([comment, 'comment']);
  return tokens;
};

const ini: Lexer = line => {
  if (/^\s*[#;]/.test(line)) return [[line, 'comment']];
  if (/^\s*\[.*\]\s*$/.test(line)) return [[line, 'heading']];
  const pair = /^(\s*[\w.-]+)(\s*=\s*)(.*)$/.exec(line);
  return pair ? [[pair[1] ?? '', 'key'], [pair[2] ?? '', 'punct'], value(pair[3] ?? '')] : [[line]];
};

const markdown: Lexer = (line, state) => {
  if (/^\s*(```|~~~)/.test(line)) {
    state.fenced = !state.fenced;
    return [[line, 'punct']];
  }
  if (state.fenced) return [[line, 'code']];
  if (/^#{1,6}\s/.test(line)) return [[line, 'heading']];
  const bullet = /^(\s*(?:[-*+]|\d+\.)\s)(.*)$/.exec(line);
  const [lead, rest]: [Token[], string] = bullet ? [[[bullet[1] ?? '', 'punct']], bullet[2] ?? ''] : [[], line];
  return [...lead, ...rest.split(/(`[^`]+`)/).map((part): Token => (part.startsWith('`') ? [part, 'code'] : [part]))];
};

const lexerFor = (path: string): Lexer | undefined => {
  const name = path.split('/').pop() ?? path;
  if (/\.ya?ml$/.test(name)) return yaml;
  if (/\.md$/.test(name)) return markdown;
  if (/^\.env|\.(service|timer|socket|toml|ini|conf)$/.test(name)) return ini;
};

const render = (tokens: Token[], key: number) => (
  <span key={key}>
    {tokens.map(([text, t], i) =>
      t ? (
        <span key={i} className={tint[t]}>
          {text}
        </span>
      ) : (
        text
      )
    )}
    {'\n'}
  </span>
);

/** Line-based highlighting for YAML, Markdown with YAML frontmatter, and env, ini or systemd files. */
export const highlight = (path: string, source: string): ReactNode => {
  const lexer = lexerFor(path);
  if (!lexer) return source;
  const lines = source.split('\n');
  const state = { fenced: false };
  const frontmatterEnd = lexer === markdown && lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  return lines.map((line, i) => {
    if (frontmatterEnd > 0 && i <= frontmatterEnd)
      return render(i === 0 || i === frontmatterEnd ? [[line, 'punct']] : yaml(line, state), i);
    return render(lexer(line, state), i);
  });
};
