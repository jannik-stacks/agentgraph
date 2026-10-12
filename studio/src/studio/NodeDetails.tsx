import { useAtomValue, useSetAtom } from 'jotai';
import { createContext, lazy, type ReactNode, Suspense, use, useMemo } from 'react';
import { Mode } from '../../../src/schema.ts';
import { type GraphModel, type GraphNode, modeTone } from '../graph-model.ts';
import { type SourceFile, SourceView } from '../source/SourceView.tsx';
import { filesAtom, navigateAtom } from '../state.ts';
import { Badge, Chip, Chips, cx, Field, Fields, Pre, Section, useStoredFlag } from '../ui.tsx';
import { kindDot } from './styles.ts';

const Markdown = lazy(() => import('./Markdown.tsx'));

type Target = { href: string; onClick: () => void };

const useLinks = (model: GraphModel) => {
  const navigate = useSetAtom(navigateAtom);
  const files = useAtomValue(filesAtom);
  return useMemo(() => {
    const nodes = new Map(model.nodes.map(n => [n.id, n]));
    const go = (path: string, query?: Record<string, string>): Target => ({
      href: query ? `${path}?${new URLSearchParams(query)}` : path,
      onClick: () => navigate({ path, ...(query && { query }) }),
    });
    return {
      nodes,
      files: files ?? [],
      node: (id: string) => (nodes.has(id) ? go('/studio', { node: id }) : undefined),
      file: (file: Pick<SourceFile, 'root' | 'path'>) => go('/studio/setup', { file: `${file.root}:${file.path}` }),
      page: (path: string) => go(path),
    };
  }, [model, files, navigate]);
};

type Links = ReturnType<typeof useLinks>;
const LinksContext = createContext<Links | null>(null);
const useLinksContext = () => use(LinksContext)!;

const refs: Record<string, (value: string) => string | undefined> = {
  bot: v => `bot:${v}`,
  skill: v => `skill:${v}`,
  skills: v => `skill:${v}`,
  check: v => `check:${v}`,
  checks: v => `check:${v}`,
  notes: v => `note:${v}`,
  tools: v => `tool:${v}`,
  preload: v => (v === 'notes' ? undefined : 'issues:issues'),
};

const mono = new Set(['branch', 'branches', 'command', 'cron', 'paths', 'tools', 'types']);
const lead = new Set(['role', 'prompt', 'run']);
const identity = ['harness', 'model', 'mode'] as const;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const modelAlias = (files: SourceFile[], alias: string) => {
  const configs = files.filter(f => /litellm[^/]*\.ya?ml$/.test(f.path)).sort((a, b) => a.path.length - b.path.length);
  const pattern = new RegExp(`model_name:\\s*${escape(alias)}\\s*\\n[\\s\\S]*?\\bmodel:\\s*(\\S+)`);
  for (const file of configs) {
    const match = pattern.exec(file.source);
    if (match) return { file, upstream: match[1] };
  }
};

const NodeChip = ({ id, label, title }: { id: string; label?: string | undefined; title?: string | undefined }) => {
  const links = useLinksContext();
  const node = links.nodes.get(id);
  const kind = node?.kind ?? (id.split(':')[0] as GraphNode['kind']);
  return (
    <Chip dot={kindDot[kind]} title={title ?? `${kind} ${node?.label ?? id}`} {...links.node(id)}>
      {label ?? node?.label ?? id.replace(/^[a-z]+:/, '')}
    </Chip>
  );
};

/** A scalar inside a property: a node chip when its key names a hub item, else a plain chip or text. */
const Scalar = ({ path, value, chip }: { path: string[]; value: string; chip?: boolean }) => {
  const links = useLinksContext();
  const key = path.at(-1) ?? '';
  const ref = path.toReversed().find(k => k in refs);
  const id = ref && refs[ref]?.(value);
  if (id && links.nodes.has(id)) return <NodeChip id={id} label={value} />;
  if (key === 'workflow') {
    const file = links.files.find(f => f.root === 'hub' && f.path.replace(/\.md$/, '') === `workflows/${value}`);
    if (file)
      return (
        <Chip dot="bg-violet-500" title={`workflow ${value}, ${file.path}`} {...links.file(file)}>
          {value}
        </Chip>
      );
  }
  if (key === 'harness') return <Chip dot="bg-sky-500" title="harness reference" {...links.page('/docs/reference/harnesses')}>{value}</Chip>;
  if (key === 'model') {
    const alias = modelAlias(links.files, value);
    return alias ? (
      <Chip dot="bg-violet-500" title={`model alias for ${alias.upstream}, in ${alias.file.path}`} {...links.file(alias.file)}>
        {value}
      </Chip>
    ) : (
      <Chip>{value}</Chip>
    );
  }
  if (key === 'mode') {
    const mode = Mode.safeParse(value);
    return <Badge tone={mode.success ? modeTone[mode.data] : 'neutral'}>{value}</Badge>;
  }
  if (chip) return <Chip mono={mono.has(ref ?? key)}>{value}</Chip>;
  return <span className={cx(mono.has(key) && 'font-mono text-xs')}>{value}</span>;
};

const Code = ({ text }: { text: string }) => {
  const links = useLinksContext();
  const mentioned = links.files.filter(f => f.path.includes('/') && text.includes(f.path));
  return (
    <div className="space-y-1.5">
      <pre className="whitespace-pre-wrap rounded bg-zinc-100 p-2 font-mono text-xs [overflow-wrap:anywhere] dark:bg-zinc-900">
        {text}
      </pre>
      {mentioned.length > 0 && (
        <Chips>
          {mentioned.map(f => (
            <Chip key={`${f.root}:${f.path}`} dot="bg-slate-500" mono title="open in setup" {...links.file(f)}>
              {f.path}
            </Chip>
          ))}
        </Chips>
      )}
    </div>
  );
};

const Prose = ({ text }: { text: string }) => {
  const links = useLinksContext();
  const code = (span: string) => {
    const id = ['bot', 'skill', 'check', 'tool', 'note'].map(kind => `${kind}:${span}`).find(k => links.nodes.has(k));
    return id ? (
      <span className="not-prose">
        <NodeChip id={id} />
      </span>
    ) : undefined;
  };
  return (
    <Suspense fallback={<p className="whitespace-pre-wrap text-[13px] leading-relaxed">{text}</p>}>
      <Markdown text={text} code={code} />
    </Suspense>
  );
};

const Value = ({ path, value }: { path: string[]; value: unknown }): ReactNode => {
  if (value === null || value === undefined) return <span className="text-zinc-400">-</span>;
  if (typeof value === 'boolean') return <Badge tone={value ? 'ok' : 'neutral'}>{value ? 'yes' : 'no'}</Badge>;
  if (typeof value === 'number' || typeof value === 'bigint') return <span className="tabular-nums">{String(value)}</span>;
  if (typeof value === 'string') {
    if (path.at(-1) === 'run') return <Code text={value} />;
    if (value.includes('\n')) return <Prose text={value} />;
    return <Scalar path={path} value={value} />;
  }
  if (Array.isArray(value)) {
    if (!value.length) return <span className="text-zinc-400">none</span>;
    if (value.every(item => typeof item !== 'object' || item === null))
      return (
        <Chips>
          {value.map(item => (
            <Scalar key={String(item)} path={path} value={String(item)} chip />
          ))}
        </Chips>
      );
    return (
      <div className="space-y-1.5">
        {value.map((item, i) => (
          <div key={i} className="rounded border border-zinc-200 p-2 dark:border-zinc-800">
            <Value path={path} value={item} />
          </div>
        ))}
      </div>
    );
  }
  if (typeof value === 'object') return <Properties path={path} entries={Object.entries(value)} />;
  return String(value);
};

const Properties = ({ path, entries }: { path: string[]; entries: [string, unknown][] }) =>
  entries.length ? (
    <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2">
      {entries.map(([key, value]) => (
        <Field key={key} name={key}>
          <Value path={[...path, key]} value={value} />
        </Field>
      ))}
    </dl>
  ) : null;

type Note = { slug: string; title?: string; status?: string; check?: string };

const NoteList = ({ kind, notes }: { kind: string; notes: Note[] }) => {
  const links = useLinksContext();
  if (!notes.length) return <p className="text-zinc-500">No {kind} notes yet.</p>;
  return (
    <ul className="divide-y divide-zinc-200 rounded border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
      {notes.map(note => {
        const file = links.files.find(f => f.root === 'hub' && f.path === `notes/${kind}/${note.slug}.md`);
        return (
          <li key={note.slug} className="flex flex-wrap items-center gap-2 px-2 py-1.5">
            {file ? (
              <a
                {...links.file(file)}
                onClick={e => {
                  e.preventDefault();
                  links.file(file).onClick();
                }}
                className="font-medium hover:text-sky-700 hover:underline dark:hover:text-sky-300"
              >
                {note.title ?? note.slug}
              </a>
            ) : (
              <span className="font-medium">{note.title ?? note.slug}</span>
            )}
            <span className="font-mono text-[11px] text-zinc-500">{note.slug}</span>
            <span className="ml-auto flex items-center gap-1">
              {note.status && <Badge tone={note.status === 'accepted' ? 'ok' : 'neutral'}>{note.status}</Badge>}
              {note.check && <NodeChip id={`check:${note.check}`} />}
            </span>
          </li>
        );
      })}
    </ul>
  );
};

const Header = ({ node, data }: { node: GraphNode; data: Record<string, unknown> }) => {
  const shown = identity.filter(key => typeof data[key] === 'string');
  const values = new Set(Object.values(data).flat());
  const description = typeof data.description === 'string' ? data.description : undefined;
  const summary = description ?? (Object.keys(data).length ? undefined : node.detail?.summary);
  return (
    <header className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5 text-[10px] uppercase tracking-wide text-zinc-500">
        <span className={cx('size-2 rounded-full', kindDot[node.kind])} />
        {node.kind}
        {node.badges
          ?.filter(badge => !values.has(badge.text))
          .map(badge => (
            <Badge key={badge.text} {...(badge.tone && { tone: badge.tone })}>
              {badge.text}
            </Badge>
          ))}
      </div>
      <h2 className="text-lg font-semibold leading-tight">{node.label}</h2>
      {summary && <p className="text-zinc-600 dark:text-zinc-400">{summary}</p>}
      {shown.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
          {shown.map(key => (
            <span key={key} className="inline-flex items-center gap-1.5">
              {key}
              <Scalar path={[key]} value={String(data[key])} />
            </span>
          ))}
        </div>
      )}
    </header>
  );
};

const Lead = ({ name, value }: { name: string; value: string }) => (
  <Section title={name}>
    {name === 'run' ? (
      <Code text={value} />
    ) : (
      <div className="rounded-lg border border-zinc-200 bg-zinc-50/70 px-3.5 py-3 dark:border-zinc-800 dark:bg-zinc-900/60">
        <Prose text={value} />
      </div>
    )}
  </Section>
);

const Connections = ({ node, model }: { node: GraphNode; model: GraphModel }) => {
  const group = (direction: 'from' | 'to') => {
    const other = direction === 'from' ? 'to' : 'from';
    const byKind = new Map<string, { id: string; label?: string | undefined }[]>();
    for (const edge of model.edges.filter(e => e[direction] === node.id)) {
      const items = byKind.get(edge.kind) ?? [];
      if (!items.some(item => item.id === edge[other])) items.push({ id: edge[other], label: edge.label });
      byKind.set(edge.kind, items);
    }
    return [...byKind];
  };
  const blocks = [
    ['uses', group('from')],
    ['used by', group('to')],
  ] as const;
  if (blocks.every(([, kinds]) => !kinds.length)) return null;
  return (
    <>
      {blocks.map(([title, kinds]) =>
        kinds.length ? (
          <Section key={title} title={title}>
            <Fields>
              {kinds.map(([kind, items]) => (
                <Field key={kind} name={kind}>
                  <Chips>
                    {items.map(item => (
                      <NodeChip key={item.id} id={item.id} {...(item.label && { title: item.label })} />
                    ))}
                  </Chips>
                </Field>
              ))}
            </Fields>
          </Section>
        ) : null
      )}
    </>
  );
};

const NodeSource = ({ source }: { source: NonNullable<GraphNode['source']> }) => {
  const links = useLinksContext();
  const [open, setOpen] = useStoredFlag('bhm.studio.source-open', false);
  const file = links.files.find(f => f.root === source.root && f.path === source.path);
  if (!file) return null;
  const setup = links.file(file);
  return (
    <details
      open={open}
      onToggle={e => setOpen(e.currentTarget.open)}
      className="group rounded border border-zinc-200 dark:border-zinc-800"
    >
      <summary className="flex cursor-pointer select-none items-center gap-2 px-2.5 py-1.5 text-xs text-zinc-600 marker:content-none hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-900 [&::-webkit-details-marker]:hidden">
        <span className="inline-block transition-transform group-open:rotate-90">›</span>
        <span className="font-semibold uppercase tracking-wide text-zinc-500">source</span>
        <span className="truncate font-mono text-zinc-500">{file.path}</span>
        <a
          href={setup.href}
          onClick={e => {
            e.preventDefault();
            setup.onClick();
          }}
          className="ml-auto shrink-0 hover:text-sky-700 hover:underline dark:hover:text-sky-300"
        >
          open in setup
        </a>
      </summary>
      <div className="border-t border-zinc-200 p-2 dark:border-zinc-800">
        <SourceView file={file} />
      </div>
    </details>
  );
};

const Fallback = ({ node }: { node: GraphNode }) => (
  <>
    {node.detail?.fields?.length ? (
      <Fields>
        {node.detail.fields.map(([name, value]) => (
          <Field key={name} name={name}>
            {value}
          </Field>
        ))}
      </Fields>
    ) : null}
    {node.detail?.sections?.map(section => (
      <Section key={section.title} title={section.title}>
        <Pre>{section.body}</Pre>
      </Section>
    ))}
  </>
);

/**
 * A rendered hub item: identity, its long text as Markdown, its properties with every reference as a link, its
 * connections, and its source file collapsed underneath.
 */
export const NodeDetails = ({ node, model }: { node: GraphNode; model: GraphModel }) => {
  const links = useLinks(model);
  const data = node.data;
  const entries = Object.entries(data ?? {}).filter(
    ([key]) => key !== 'description' && !identity.some(k => k === key && typeof data?.[k] === 'string')
  );
  const isLead = ([key, value]: [string, unknown]) =>
    typeof value === 'string' && (lead.has(key) || value.includes('\n'));
  return (
    <LinksContext value={links}>
      <div className="space-y-5">
        <Header node={node} data={data ?? {}} />
        {data ? (
          <>
            {entries.filter(isLead).map(([key, value]) => (
              <Lead key={key} name={key} value={String(value)} />
            ))}
            {node.kind === 'note' && Array.isArray(data.notes) ? (
              <NoteList kind={node.label} notes={data.notes as Note[]} />
            ) : (
              <Properties path={[]} entries={entries.filter(entry => !isLead(entry))} />
            )}
          </>
        ) : (
          <Fallback node={node} />
        )}
        <Connections node={node} model={model} />
        {node.source && <NodeSource source={node.source} />}
      </div>
    </LinksContext>
  );
};
