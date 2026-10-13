import type { ComponentType } from 'react';
import { Badge, Chip, Chips, cx } from '../../ui.tsx';
import { Highlighted, JsonView, json, Label, parseJson, Text, WithRaw } from './core.tsx';

type Input = Record<string, unknown>;
type ToolProps = { input: Input; output?: string | undefined; ok?: boolean | undefined };

const str = (value: unknown) => (typeof value === 'string' ? value : value === undefined ? '' : String(value));
const rel = (path: unknown) => str(path).replace(/^\/work\/?/, '') || '.';
const clip = (text: string, max = 80) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const languages: Record<string, string> = {
  ts: 'ts',
  mts: 'ts',
  tsx: 'tsx',
  js: 'js',
  mjs: 'js',
  jsx: 'jsx',
  json: 'json',
  jsonl: 'json',
  md: 'markdown',
  mdx: 'mdx',
  yaml: 'yaml',
  yml: 'yaml',
  sh: 'bash',
  css: 'css',
  html: 'html',
  py: 'python',
  toml: 'toml',
};
const langOf = (path: unknown) => languages[/\.(\w+)$/.exec(str(path))?.[1] ?? ''] ?? 'text';

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
    .map(line => line.replace(/^\d+: ?/, ''))
    .join('\n')
    .trimEnd();
};

const Output = ({ output, ok }: Pick<ToolProps, 'output' | 'ok'>) => {
  if (output === undefined || output === '') return null;
  const parsed = parseJson(output);
  if (parsed !== undefined) return <JsonView value={parsed} label="output" />;
  return <Highlighted code={output} className={cx(ok === false && 'text-red-700 dark:text-red-300')} />;
};

const Path = ({ path, suffix = '' }: { path: unknown; suffix?: string }) => (
  <div className="font-mono text-[11px] text-zinc-600 dark:text-zinc-400">
    {rel(path)}
    {suffix}
  </div>
);

const Read = ({ input, output, ok }: ToolProps) => (
  <>
    <Path path={input.filePath ?? input.path} suffix={range(input)} />
    {ok === false || output === undefined ? (
      <Output output={output} ok={ok} />
    ) : (
      <Highlighted code={fileText(output)} lang={langOf(input.filePath ?? input.path)} />
    )}
  </>
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

const Grep = ({ input, output, ok }: ToolProps) => {
  const files = ok === false || !output ? [] : grepMatches(output);
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-2 font-mono text-[11px]">
        <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">{str(input.pattern)}</code>
        <Label>in</Label>
        <span>{rel(input.path)}</span>
        {input.include !== undefined && <span className="text-zinc-500">{str(input.include)}</span>}
      </div>
      {files.length ? (
        <ul className="space-y-1 font-mono text-[11px]">
          {files.map(({ file, lines }) => (
            <li key={file}>
              <div className="text-zinc-600 dark:text-zinc-400">{file}</div>
              {lines.map(({ line, text }, i) => (
                <div key={i} className="flex gap-2 pl-3">
                  <span className="shrink-0 text-zinc-400 tabular-nums">{line}</span>
                  <span className="truncate">{text}</span>
                </div>
              ))}
            </li>
          ))}
        </ul>
      ) : (
        <Output output={output} ok={ok} />
      )}
    </>
  );
};

const Glob = ({ input, output, ok }: ToolProps) => (
  <>
    <div className="font-mono text-[11px]">
      <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">{str(input.pattern)}</code>
      {input.path !== undefined && <span className="ml-2 text-zinc-500">{rel(input.path)}</span>}
    </div>
    {ok === false || !output ? (
      <Output output={output} ok={ok} />
    ) : (
      <ul className="font-mono text-[11px]">
        {output
          .split('\n')
          .filter(Boolean)
          .map(line => (
            <li key={line}>{rel(line)}</li>
          ))}
      </ul>
    )}
  </>
);

const Bash = ({ input, output, ok }: ToolProps) => (
  <>
    {input.description !== undefined && <div className="text-zinc-500">{str(input.description)}</div>}
    <Highlighted code={str(input.command)} lang="bash" />
    <Output output={output} ok={ok} />
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

const Diff = ({ before, after }: { before: string; after: string }) => (
  <pre className="max-h-96 overflow-auto rounded border border-zinc-200 font-mono text-[11px] leading-4 dark:border-zinc-800">
    {diffLines(before, after).map(({ sign, text }, i) => (
      <div key={i} className={cx('px-2 whitespace-pre-wrap break-words', signTint[sign])}>
        {sign} {text}
      </div>
    ))}
  </pre>
);

const Edit = ({ input, output, ok }: ToolProps) => (
  <>
    <Path path={input.filePath} />
    <Diff before={str(input.oldString)} after={str(input.newString)} />
    {(ok === false || (output && !/^Edit applied/.test(output))) && <Output output={output} ok={ok} />}
  </>
);

const Write = ({ input, output, ok }: ToolProps) => (
  <>
    <Path path={input.filePath} />
    <Highlighted code={str(input.content)} lang={langOf(input.filePath)} />
    {ok === false && <Output output={output} ok={ok} />}
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
    <JsonView value={input} label="input" />
    <Output output={output} ok={ok} />
  </>
);

const tools: Record<string, { summary: (input: Input) => string; Body: ComponentType<ToolProps> }> = {
  read: { summary: i => `${rel(i.filePath ?? i.path)}${range(i)}`, Body: Read },
  grep: { summary: i => `${str(i.pattern)} in ${rel(i.path)}`, Body: Grep },
  glob: { summary: i => str(i.pattern), Body: Glob },
  bash: { summary: i => clip(str(i.command).split('\n')[0] ?? ''), Body: Bash },
  edit: { summary: i => rel(i.filePath), Body: Edit },
  write: { summary: i => rel(i.filePath), Body: Write },
  issues_get: { summary: i => `#${str(i.number)}`, Body: IssueGet },
  issues_list: { summary: i => clip(json(i).replace(/\s+/g, ' ')), Body: TextOutput },
  notes_search: { summary: i => str(i.query), Body: TextOutput },
  notes_get: { summary: i => str(i.path ?? i.slug ?? i.id), Body: TextOutput },
  notes_add: { summary: i => str(i.title), Body: NoteAdd },
};

const known = (tool: string) => tools[tool.replace(/^bothub_/, '')];
const record = (input: unknown): Input =>
  input && typeof input === 'object' && !Array.isArray(input) ? (input as Input) : { value: input };

/** A one-line summary of a tool call's arguments, for its collapsed row. */
export const toolSummary = (tool: string, input: unknown) =>
  known(tool)?.summary(record(input)) ?? clip(JSON.stringify(input)?.replace(/\s+/g, ' ') ?? '');

/** A tool call's arguments and result, drawn for what the tool is. */
export const ToolBody = ({
  tool,
  input,
  output,
  ok,
}: {
  tool: string;
  input: unknown;
  output?: string | undefined;
  ok?: boolean | undefined;
}) => {
  const entry = known(tool);
  const props = { input: record(input), output, ok };
  return (
    <div
      className={cx(
        'min-w-0 space-y-1.5 text-xs',
        ok === false && 'rounded border-l-2 border-red-400 pl-2 dark:border-red-700'
      )}
    >
      {entry ? (
        <WithRaw value={{ input, output }}>
          <div className="space-y-1.5">
            <entry.Body {...props} />
          </div>
        </WithRaw>
      ) : (
        <Unknown {...props} />
      )}
    </div>
  );
};
