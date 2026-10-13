import { type ComponentType, type ReactNode, useState } from 'react';
import { langOf } from '../../source/lang.ts';
import { Icon } from '../../studio/icons.tsx';
import { Badge, Chip, Chips, cx } from '../../ui.tsx';
import { Code, codeSurface } from '../../Markdown.tsx';
import { json, Label, parseJson, Raw, Text } from './core.tsx';

type Input = Record<string, unknown>;
type ToolProps = { input: Input; output?: string | undefined; ok?: boolean | undefined };

const str = (value: unknown) => (typeof value === 'string' ? value : value === undefined ? '' : String(value));
const rel = (path: unknown) => str(path).replace(/^\/work\/?/, '') || '.';
const clip = (text: string, max = 80) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The first of `keys` the input has, so one view reads both opencode's camelCase and other harnesses' snake_case. */
const pick = (input: Input, ...keys: string[]) => input[keys.find(key => input[key] !== undefined) ?? ''];
const pathOf = (input: Input) => pick(input, 'filePath', 'file_path', 'path');

const range = (input: Input) => {
  const offset = typeof input.offset === 'number' ? input.offset : undefined;
  const limit = typeof input.limit === 'number' ? input.limit : undefined;
  if (offset === undefined && limit === undefined) return '';
  const from = offset ?? 1;
  return limit === undefined ? `:${from}` : `:${from}-${from + limit - 1}`;
};

/** The file text inside opencode's read wrapper, without its line-number prefixes. */
const fileText = (output: string) => {
  const content = /<content>\n?([\s\S]*?)<\/content>/.exec(output)?.[1] ?? output;
  return content
    .split('\n')
    .filter(line => !/^\(End of file/.test(line))
    .map(line => line.replace(/^\s*\d+(?::|\t|→) ?/, ''))
    .join('\n')
    .trimEnd();
};

const quiet = 'font-mono text-[11px] text-zinc-500';

const Output = ({ output, ok, lines = 8 }: Pick<ToolProps, 'output' | 'ok'> & { lines?: number }) => {
  if (output === undefined || output === '') return null;
  if (output.trim() === '(no output)') return <div className={quiet}>no output</div>;
  const parsed = parseJson(output);
  if (parsed !== undefined) return <Raw value={parsed} />;
  return (
    <Code
      code={output.replace(/^\n+|\s+$/g, '')}
      compact
      lines={lines}
      className={cx(ok === false && 'text-red-700 dark:text-red-300')}
    />
  );
};

/** A list of short lines, the first `max` shown and a button to the rest of the `noun`s. */
const More = <T,>({
  items,
  max,
  noun,
  className,
  row,
}: {
  items: T[];
  max: number;
  noun: string;
  className?: string;
  row: (item: T, i: number) => ReactNode;
}) => {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, max);
  const left = items.length - max;
  return (
    <>
      {shown.map(row)}
      {left > 0 && (
        <button
          type="button"
          className={cx(quiet, 'block hover:text-sky-700 dark:hover:text-sky-300', className)}
          onClick={() => setAll(!all)}
        >
          {all ? 'show fewer' : `${left} more ${noun}${left === 1 ? '' : 's'}`}
        </button>
      )}
    </>
  );
};

const Read = ({ input, output, ok }: ToolProps) =>
  ok === false || output === undefined ? (
    <Output output={output} ok={ok} />
  ) : (
    <Code code={fileText(output)} lang={langOf(str(pathOf(input)))} compact lines={12} />
  );

/** opencode grep output: "Found N matches", then each file followed by its "Line N: text" lines. */
const grepMatches = (output: string) => {
  const files: { file: string; lines: { line: string; text: string }[] }[] = [];
  for (const raw of output.split('\n')) {
    const match = /^\s+Line (\d+):\s?(.*)$/.exec(raw);
    if (match) files.at(-1)?.lines.push({ line: match[1] ?? '', text: match[2] ?? '' });
    else if (/^\S.*:$/.test(raw) && !/^Found \d+/.test(raw)) files.push({ file: rel(raw.slice(0, -1)), lines: [] });
  }
  return files;
};

/** The grep pattern as a global regex: as written when it compiles, else literally. */
const patternOf = (input: Input) => {
  const pattern = str(input.pattern);
  if (!pattern) return;
  const flags = input['-i'] === true || input.ignoreCase === true || input.caseSensitive === false ? 'gi' : 'g';
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags);
  } catch {
    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  }
  return regex.test('') ? undefined : regex;
};

const marksPerLine = 20;

/** `text` with the matches of `regex` tinted, unless it matches nothing or the whole line. */
const Matched = ({ text, regex }: { text: string; regex: RegExp | undefined }) => {
  if (!regex) return text;
  const parts: ReactNode[] = [];
  let last = 0;
  regex.lastIndex = 0;
  for (const match of text.matchAll(regex)) {
    if (parts.length >= marksPerLine * 2) break;
    const at = match.index;
    if (at === 0 && match[0].length === text.length) return text;
    parts.push(text.slice(last, at));
    parts.push(
      <mark key={at} className="rounded-sm bg-amber-100 text-inherit dark:bg-amber-500/20">
        {match[0]}
      </mark>
    );
    last = at + match[0].length;
  }
  if (!parts.length) return text;
  parts.push(text.slice(last));
  return parts;
};

const Grep = ({ input, output, ok }: ToolProps) => {
  const files = ok === false || !output ? [] : grepMatches(output);
  const regex = patternOf(input);
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-2 font-mono text-[11px]">
        <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">{str(input.pattern)}</code>
        <Label>in</Label>
        <span>{rel(input.path)}</span>
        {pick(input, 'include', 'glob') !== undefined && (
          <span className="text-zinc-500">{str(pick(input, 'include', 'glob'))}</span>
        )}
      </div>
      {files.length ? (
        <ul className="space-y-1 font-mono text-[11px]">
          <More
            items={files}
            max={12}
            noun="file"
            row={({ file, lines }) => (
              <li key={file}>
                <div className="text-zinc-600 dark:text-zinc-400">{file}</div>
                {lines.map(({ line, text }, i) => (
                  <div key={i} className="flex gap-2 pl-3">
                    <span className="w-8 shrink-0 text-right text-zinc-400 tabular-nums">{line}</span>
                    <span className="truncate">
                      <Matched text={text} regex={regex} />
                    </span>
                  </div>
                ))}
              </li>
            )}
          />
        </ul>
      ) : (
        <Output output={output} ok={ok} />
      )}
    </>
  );
};

const Paths = ({ paths }: { paths: string[] }) => (
  <ul className="font-mono text-[11px]">
    <More
      items={paths}
      max={16}
      noun="path"
      row={path => (
        <li key={path} className="flex items-center gap-1.5 truncate">
          <Icon name="file" className="size-3 text-zinc-400" />
          {path}
        </li>
      )}
    />
  </ul>
);

const Glob = ({ input, output, ok }: ToolProps) => {
  const paths = (output ?? '')
    .split('\n')
    .filter(line => line.startsWith('/'))
    .map(rel);
  return (
    <>
      <div className="font-mono text-[11px]">
        <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">{str(input.pattern)}</code>
        {input.path !== undefined && <span className="ml-2 text-zinc-500">{rel(input.path)}</span>}
      </div>
      {ok === false || !paths.length ? <Output output={output} ok={ok} /> : <Paths paths={paths} />}
    </>
  );
};

/** A command as one shell prompt line; a longer or multi-line one opens in place. */
const Prompt = ({ command }: { command: string }) => {
  const [open, setOpen] = useState(false);
  const long = command.includes('\n') || command.length > 120;
  if (open) return <Code code={command} lang="bash" compact />;
  return (
    <div className={cx(codeSurface, 'flex min-w-0 items-center gap-2 px-3 py-1 font-mono text-[11px]')}>
      <span className="shrink-0 text-zinc-400 select-none">$</span>
      <span className="min-w-0 flex-1 truncate">{command.split('\n')[0]}</span>
      {long && (
        <button
          type="button"
          className="shrink-0 text-zinc-500 hover:text-sky-700 dark:hover:text-sky-300"
          onClick={() => setOpen(true)}
        >
          {command.includes('\n') ? `${command.split('\n').length} lines` : 'full'}
        </button>
      )}
    </div>
  );
};

const Bash = ({ input, output, ok }: ToolProps) => (
  <>
    {input.description !== undefined && <div className="text-zinc-500">{str(input.description)}</div>}
    <Prompt command={str(input.command)} />
    <Output output={output} ok={ok} lines={6} />
  </>
);

/** Changed lines between two texts, with the lines both share at the start and end as context. */
const diffLines = (before: string, after: string) => {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const context = (lines: string[]) => lines.slice(-2).map(text => ({ sign: ' ', text }));
  return [
    ...context(a.slice(0, start)),
    ...a.slice(start, a.length - end).map(text => ({ sign: '-', text })),
    ...b.slice(start, b.length - end).map(text => ({ sign: '+', text })),
    ...a
      .slice(a.length - end)
      .slice(0, 2)
      .map(text => ({ sign: ' ', text })),
  ];
};

const signTint: Record<string, string> = {
  '-': 'bg-red-50 text-red-800 dark:bg-red-950/50 dark:text-red-300',
  '+': 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300',
  ' ': 'text-zinc-500',
};

const Diff = ({ lines }: { lines: { sign: string; text: string }[] }) => (
  <pre className={cx(codeSurface, 'overflow-hidden py-1 font-mono text-[11px] leading-4')}>
    <More
      items={lines}
      max={16}
      noun="line"
      className="px-3 pt-0.5"
      row={({ sign, text }, i) => (
        <div key={i} className={cx('px-3 break-words whitespace-pre-wrap', signTint[sign])}>
          {sign} {text}
        </div>
      )}
    />
  </pre>
);

const Edit = ({ input, output, ok }: ToolProps) => (
  <>
    <Diff lines={diffLines(str(pick(input, 'oldString', 'old_string')), str(pick(input, 'newString', 'new_string')))} />
    {(ok === false || (output && !/^Edit applied/.test(output))) && <Output output={output} ok={ok} />}
  </>
);

const Write = ({ input, output, ok }: ToolProps) => (
  <>
    <Code code={str(input.content)} lang={langOf(str(pathOf(input)))} compact lines={12} />
    {ok === false && <Output output={output} ok={ok} />}
  </>
);

type Todo = { content?: string; status?: string; priority?: string };

const todoGlyph = { completed: 'ok', in_progress: 'live', cancelled: 'skipped' } as const;

const Todos = ({ input, output, ok }: ToolProps) => {
  const todos = (Array.isArray(input.todos) ? input.todos : parseJson(output)) as Todo[] | undefined;
  if (!Array.isArray(todos)) return <Output output={output} ok={ok} />;
  return (
    <ul className="space-y-0.5">
      {todos.map((todo, i) => (
        <li
          key={i}
          className={cx(
            'flex items-start gap-1.5',
            todo.status === 'completed' && 'text-zinc-500 line-through',
            todo.status === 'cancelled' && 'text-zinc-400 line-through'
          )}
        >
          <Icon
            name={todoGlyph[todo.status as keyof typeof todoGlyph] ?? 'queued'}
            className={cx('mt-0.5 size-3', todo.status === 'in_progress' ? 'text-sky-600' : 'text-zinc-400')}
          />
          <span className="min-w-0">{todo.content}</span>
        </li>
      ))}
    </ul>
  );
};

const WebFetch = ({ input, output, ok }: ToolProps) => (
  <>
    <a
      href={str(input.url)}
      target="_blank"
      rel="noreferrer"
      className="block truncate font-mono text-[11px] text-sky-700 hover:underline dark:text-sky-300"
    >
      {str(input.url)}
    </a>
    {input.prompt !== undefined && <div className="text-zinc-500">{str(input.prompt)}</div>}
    <Output output={output} ok={ok} />
  </>
);

const Task = ({ input, output, ok }: ToolProps) => (
  <>
    <div className="flex items-center gap-1.5">
      {pick(input, 'subagent_type', 'subagentType') !== undefined && (
        <Badge>{str(pick(input, 'subagent_type', 'subagentType'))}</Badge>
      )}
      <span className="font-medium">{str(input.description)}</span>
    </div>
    <Code code={str(input.prompt)} compact wrap lines={4} />
    {output && ok !== false && parseJson(output) === undefined ? (
      <Text text={output} />
    ) : (
      <Output output={output} ok={ok} />
    )}
  </>
);

type Issue = { number?: number; title?: string; state?: string; labels?: string[]; body?: string };

const IssueGet = ({ output, ok }: ToolProps) => {
  const issue = parseJson(output) as Issue | undefined;
  if (ok === false || !issue || typeof issue.body !== 'string') {
    if (output && parseJson(output) === undefined && ok !== false) return <Text text={output} />;
    return <Output output={output} ok={ok} />;
  }
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">
          #{issue.number} {issue.title}
        </span>
        {issue.state && <Badge tone={issue.state === 'open' ? 'ok' : 'neutral'}>{issue.state}</Badge>}
        {issue.labels?.length ? (
          <Chips>
            {issue.labels.map(label => (
              <Chip key={label}>{label}</Chip>
            ))}
          </Chips>
        ) : null}
      </div>
      <Text text={issue.body} />
    </>
  );
};

const TextOutput = ({ output, ok }: ToolProps) =>
  output && ok !== false && parseJson(output) === undefined ? (
    <Text text={output} />
  ) : (
    <Output output={output} ok={ok} />
  );

const NoteAdd = ({ input, output, ok }: ToolProps) => (
  <>
    <div className="font-medium">{str(input.title)}</div>
    {typeof input.body === 'string' && <Text text={input.body} />}
    <Output output={output} ok={ok} />
  </>
);

const Unknown = ({ input, output, ok }: ToolProps) => (
  <>
    {Object.keys(input).length > 0 && <Raw value={input} />}
    <Output output={output} ok={ok} />
  </>
);

const listing = (output: string | undefined) =>
  (output ?? '')
    .split('\n')
    .filter(line => line.trim())
    .map(line => line.trimEnd());

const List = ({ output, ok }: ToolProps) =>
  ok === false ? <Output output={output} ok={ok} /> : <Code code={listing(output).join('\n')} compact lines={16} />;

const tools: Record<string, { summary: (input: Input) => string; Body: ComponentType<ToolProps> }> = {
  read: { summary: i => `${rel(pathOf(i))}${range(i)}`, Body: Read },
  grep: { summary: i => `${str(i.pattern)} in ${rel(i.path)}`, Body: Grep },
  glob: { summary: i => str(i.pattern), Body: Glob },
  list: { summary: i => rel(i.path), Body: List },
  ls: { summary: i => rel(i.path), Body: List },
  bash: { summary: i => clip(str(i.command).split('\n')[0] ?? ''), Body: Bash },
  edit: { summary: i => rel(pathOf(i)), Body: Edit },
  write: { summary: i => rel(pathOf(i)), Body: Write },
  todowrite: {
    summary: i => (Array.isArray(i.todos) ? `${i.todos.length} items` : ''),
    Body: Todos,
  },
  todoread: { summary: () => '', Body: Todos },
  webfetch: { summary: i => clip(str(i.url)), Body: WebFetch },
  task: { summary: i => str(i.description), Body: Task },
  issues_get: { summary: i => `#${str(i.number)}`, Body: IssueGet },
  issues_list: { summary: i => clip(json(i).replace(/\s+/g, ' ')), Body: TextOutput },
  notes_search: { summary: i => str(i.query), Body: TextOutput },
  notes_get: { summary: i => str(i.path ?? i.slug ?? i.id), Body: TextOutput },
  notes_add: { summary: i => str(i.title), Body: NoteAdd },
};

/** A tool's name as the transcript shows it: without the hub's prefix. */
export const toolName = (tool: string) => tool.replace(/^bothub_/, '');

const known = (tool: string) => tools[toolName(tool).toLowerCase()];
const record = (input: unknown): Input =>
  input && typeof input === 'object' && !Array.isArray(input) ? (input as Input) : { value: input };

/** A one-line summary of a tool call's arguments, for its collapsed row. */
export const toolSummary = (tool: string, input: unknown) =>
  known(tool)?.summary(record(input)) ?? clip(JSON.stringify(input)?.replace(/\s+/g, ' ') ?? '');

/** A tool call's arguments and result, drawn for what the tool is, or as the raw JSON when `raw` is set. */
export const ToolBody = ({
  tool,
  input,
  output,
  ok,
  raw = false,
}: {
  tool: string;
  input: unknown;
  output?: string | undefined;
  ok?: boolean | undefined;
  raw?: boolean;
}) => {
  const Body = known(tool)?.Body ?? Unknown;
  return (
    <div
      className={cx(
        'min-w-0 space-y-1.5 text-xs',
        ok === false && 'rounded border-l-2 border-red-400 pl-2 dark:border-red-700'
      )}
    >
      {raw ? <Raw value={{ input, output }} /> : <Body input={record(input)} output={output} ok={ok} />}
    </div>
  );
};
