import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import { createContext, lazy, type ReactNode, Suspense, use, useMemo } from 'react';
import { hubFile } from '../../../src/config.ts';
import { Mode, type Note } from '../../../src/schema.ts';
import { type GraphModel, type GraphNode, modeTone, type StepContext } from '../graph-model.ts';
import { type SourceFile, SourceView } from '../source/SourceView.tsx';
import { Link } from '../Providers.tsx';
import { filesAtom, hrefAtom, navigateAtom } from '../state.ts';
import { Badge, Button, Chip, Chips, cx, Disclosure, Field, Fields, InfoTip, Pre, Section, Tooltip } from '../ui.tsx';
import { mono, nodeTarget, refId, refKind } from './hub-refs.ts';
import { KindIcon, kindTitle } from './icons.tsx';

const Markdown = lazy(() => import('../Markdown.tsx'));

const useLinks = (model: GraphModel) => {
  const href = useAtomValue(hrefAtom);
  const files = useAtomValue(filesAtom);
  return useMemo(() => {
    const nodes = new Map(model.nodes.map(n => [n.id, n]));
    return {
      nodes,
      files: files ?? [],
      node: (id: string) => (nodes.has(id) ? href(nodeTarget(id)) : undefined),
      file: (file: Pick<SourceFile, 'root' | 'path'>) =>
        href({ path: '/studio/setup', query: { file: `${file.root}:${file.path}` } }),
      edit: (path: string) => href({ query: { edit: path } }),
    };
  }, [model, files, href]);
};

type Links = ReturnType<typeof useLinks>;
const LinksContext = createContext<Links | null>(null);
const useLinksContext = () => use(LinksContext)!;

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
    <Chip
      icon={<KindIcon kind={kind} className="size-3" title="" />}
      title={title ?? kindTitle[kind]}
      action="Show details"
      href={links.node(id)}
    >
      {label ?? node?.label ?? id.replace(/^[a-z]+:/, '')}
    </Chip>
  );
};

/** A scalar inside a property: a node chip when its key names a hub item, else a plain chip or text. */
const Scalar = ({ path, value, chip }: { path: string[]; value: string; chip?: boolean }) => {
  const links = useLinksContext();
  const key = path.at(-1) ?? '';
  const ref = path.findLast(k => k in refKind || k === 'preload');
  const id = ref && refId(ref, value);
  if (id && links.nodes.has(id)) return <NodeChip id={id} label={value} />;
  if (key === 'workflow') {
    const file = links.files.find(f => f.root === 'hub' && f.path.replace(/\.md$/, '') === `workflows/${value}`);
    if (file)
      return (
        <Chip
          icon={<KindIcon kind="workflow" className="size-3" title="" />}
          title={`Workflow in ${file.path}`}
          action="Open the file"
          href={links.file(file)}
        >
          {value}
        </Chip>
      );
  }
  if (key === 'harness')
    return (
      <Chip dot="bg-sky-500" title="Harness" action="Read the harness reference" href="/docs/reference/harnesses">
        {value}
      </Chip>
    );
  if (key === 'model') {
    const alias = modelAlias(links.files, value);
    return alias ? (
      <Chip
        dot="bg-violet-500"
        title={`Model alias for ${alias.upstream}`}
        action={`Open ${alias.file.path}`}
        href={links.file(alias.file)}
      >
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
            <Chip key={`${f.root}:${f.path}`} dot="bg-slate-500" mono action="Open in setup" href={links.file(f)}>
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
  if (typeof value === 'number' || typeof value === 'bigint')
    return <span className="tabular-nums">{String(value)}</span>;
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

const NoteList = ({
  kind,
  notes,
}: {
  kind: string;
  notes: (Pick<Note, 'title' | 'status' | 'check'> & { slug: string })[];
}) => {
  const links = useLinksContext();
  if (!notes.length) return <p className="text-zinc-500">No {kind} notes yet.</p>;
  return (
    <ul className="divide-y divide-zinc-200 rounded border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
      {notes.map(note => {
        const file = links.files.find(f => f.root === 'hub' && f.path === `notes/${kind}/${note.slug}.md`);
        return (
          <li key={note.slug} className="flex flex-wrap items-center gap-2 px-2 py-1.5">
            {file ? (
              <Link
                href={links.file(file)}
                className="font-medium hover:text-sky-700 hover:underline dark:hover:text-sky-300"
              >
                {note.title ?? note.slug}
              </Link>
            ) : (
              <span className="font-medium">{note.title ?? note.slug}</span>
            )}
            <span className="font-mono text-[11px] text-zinc-500">{note.slug}</span>
            <span className="ml-auto flex items-center gap-1">
              {note.status && <Badge tone={note.status === 'accepted' ? 'ok' : 'neutral'}>{note.status}</Badge>}
              {note.check && <NodeChip id={`check:${note.check}`} />}
              <EditButton path={`notes/${kind}/${note.slug}.md`} />
            </span>
          </li>
        );
      })}
    </ul>
  );
};

const EditButton = ({ path, label = 'Edit' }: { path: string; label?: string }) => {
  const navigate = useSetAtom(navigateAtom);
  return (
    <Button className="normal-case tracking-normal" onClick={() => navigate({ query: { edit: path } })}>
      {label}
    </Button>
  );
};

const Header = ({ node, data }: { node: GraphNode; data: Record<string, unknown> }) => {
  const shown = identity.filter(key => typeof data[key] === 'string');
  const values = new Set(Object.values(data).flat());
  const description = typeof data.description === 'string' ? data.description : undefined;
  const summary = description ?? (Object.keys(data).length ? undefined : node.detail?.summary);
  return (
    <header className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
        <KindIcon kind={node.kind} className="size-4" />
        <Tooltip tip={kindTitle[node.kind]}>
          <span>{node.kind}</span>
        </Tooltip>
        {node.badges
          ?.filter(badge => !values.has(badge.text))
          .map(badge => (
            <Badge key={badge.text} {...(badge.tone && { tone: badge.tone })}>
              {badge.text}
            </Badge>
          ))}
        {node.source?.root === 'hub' && (
          <span className="ml-auto">
            <EditButton
              path={node.source.path}
              label={
                node.kind === 'job' || node.kind === 'script' || node.kind === 'trigger' ? 'Edit workflow' : 'Edit'
              }
            />
          </span>
        )}
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

/** The item's `human` notes, read-only: plain text, or one row per key. */
const Human = ({ value }: { value: unknown }) => (
  <Section title="human">
    {typeof value === 'string' ? (
      <p className="text-zinc-700 dark:text-zinc-300">{value}</p>
    ) : (
      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2">
        {Object.entries(value ?? {}).map(([key, text]) => (
          <Field key={key} name={key}>
            <span className="text-zinc-700 dark:text-zinc-300">{String(text)}</span>
          </Field>
        ))}
      </dl>
    )}
  </Section>
);

const contextEdges = new Set<string>(['preloads', 'calls']);

const Labelled = ({ name, title, children }: { name: string; title?: string; children: ReactNode }) => (
  <>
    <dt className="inline-flex items-center gap-1 text-zinc-500">
      {name}
      {title && <InfoTip tip={title} />}
    </dt>
    <dd className="min-w-0">
      <Chips>{children}</Chips>
    </dd>
  </>
);

const None = ({ children = 'none' }: { children?: ReactNode }) => <span className="text-zinc-400">{children}</span>;

type PreloadItem = StepContext['preload'][number];

const preloadName = (item: PreloadItem) => (typeof item === 'string' ? item : 'recall');

const preloadMeaning = (item: PreloadItem) => {
  if (item === 'issue') return 'the issue thread';
  if (item === 'links') return 'linked issues and PRs';
  const { judge, cutoff, budget } = typeof item === 'string' ? {} : item.recall;
  return [
    'relevant notes and earlier runs',
    judge !== undefined && `judged by ${judge}`,
    cutoff !== undefined && `cutoff ${cutoff}`,
    budget !== undefined && `budget ${budget}`,
  ]
    .filter(Boolean)
    .join(', ');
};

const overText = (over: NonNullable<StepContext['over']>) =>
  typeof over === 'string'
    ? over
    : 'run' in over
      ? `run: ${over.run}`
      : 'each' in over
        ? `each: ${over.each}`
        : `each-hunk, at most ${over['each-hunk'].max}`;

/**
 * What one step hands its bot, in the order the run meets it: who acts, what it does, what it takes in, what it uses
 * while working, and what it returns.
 */
const StepContextView = ({ context, from, heading }: { context: StepContext; from: string; heading?: ReactNode }) => {
  const links = useLinksContext();
  const docs = '/docs/context';
  return (
    <div className="space-y-3 rounded-lg border border-zinc-200 p-2.5 dark:border-zinc-800">
      {heading}
      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1.5">
        {context.bot !== from && (
          <Labelled name="who" title="The bot the step casts">
            <NodeChip id={context.bot} />
          </Labelled>
        )}
        {context.skill !== from && (
          <Labelled name="does" title="The skill the step hands the bot">
            {context.skill ? <NodeChip id={context.skill} /> : <None>no skill</None>}
          </Labelled>
        )}
        <Labelled name="in" title="What the run looks at, and what it sees first in its prompt">
          {context.over && (
            <Chip mono title="What the run looks at" action="Read about context" href={docs}>
              over {overText(context.over)}
            </Chip>
          )}
          {context.preload.map(item => (
            <Chip
              key={preloadName(item)}
              mono
              title={`Preloads ${preloadMeaning(item)}`}
              action="Read about context"
              href={docs}
            >
              {preloadName(item)}
              <span className="ml-1 font-sans text-zinc-500">{preloadMeaning(item)}</span>
            </Chip>
          ))}
          {context.issues && (
            <Chip
              icon={<KindIcon kind="issues" className="size-3" />}
              title={`${context.issues} issue tracker`}
              action={`Edit ${hubFile}`}
              href={links.edit(hubFile)}
            >
              {context.issues}
            </Chip>
          )}
          {!context.over && !context.preload.length && !context.issues && <None />}
        </Labelled>
        <Labelled name="uses" title="Harness tools and read-only hub tools the run can call">
          {context.harnessTools.map(tool => (
            <Chip
              key={tool}
              mono
              title="Harness tool"
              action="Read the harness reference"
              href="/docs/reference/harnesses"
            >
              {tool}
            </Chip>
          ))}
          {context.hubTools.map(tool => (
            <Chip
              key={tool}
              icon={<KindIcon kind="tool" className="size-3" />}
              mono
              title="Read-only hub tool"
              action="Read about context"
              href={docs}
            >
              {tool}
            </Chip>
          ))}
          {!context.harnessTools.length && !context.hubTools.length && <None />}
        </Labelled>
        <Labelled name="returns" title="What the run hands back when it ends; nothing applies until the checks pass">
          {context.verdict ? (
            <Chip mono>verdict</Chip>
          ) : context.returns.length ? (
            context.returns.map(kind => (
              <Chip key={kind} mono>
                {kind}
              </Chip>
            ))
          ) : (
            <None />
          )}
        </Labelled>
      </dl>
      <p className="flex items-center gap-1.5 text-xs text-zinc-500">
        <KindIcon kind="note" className="size-3" />
        <Link href="/studio/notes" className="hover:text-sky-700 hover:underline dark:hover:text-sky-300">
          Notes are surfaced by relevance while the bot works
        </Link>
      </p>
    </div>
  );
};

/** What the selected step, or each step casting the selected bot, would see when its run starts. */
const Context = ({ node }: { node: GraphNode }) => {
  if (!node.context?.length) return null;
  if (node.kind !== 'bot')
    return (
      <Section title="context">
        <StepContextView context={node.context[0]!} from={node.id} />
      </Section>
    );
  return (
    <Section title="context">
      {node.context.map(context => (
        <StepContextView
          key={context.step}
          context={context}
          from={node.id}
          heading={
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
              cast by <NodeChip id={context.step} />
              {context.skill && (
                <>
                  with <NodeChip id={context.skill} />
                </>
              )}
            </p>
          }
        />
      ))}
    </Section>
  );
};

const Connections = ({ node, model }: { node: GraphNode; model: GraphModel }) => {
  const group = (direction: 'from' | 'to') => {
    const other = direction === 'from' ? 'to' : 'from';
    const byKind = new Map<string, { id: string; label?: string | undefined }[]>();
    for (const edge of model.edges.filter(e => e[direction] === node.id && !contextEdges.has(e.kind))) {
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

const sourceOpenAtom = atomWithStorage('bhm.studio.source-open', false, undefined, { getOnInit: true });

const NodeSource = ({ source }: { source: NonNullable<GraphNode['source']> }) => {
  const links = useLinksContext();
  const [open, setOpen] = useAtom(sourceOpenAtom);
  const file = links.files.find(f => f.root === source.root && f.path === source.path);
  if (!file) return null;
  return (
    <Disclosure
      open={open}
      onToggle={setOpen}
      summaryClassName="gap-2 py-1.5 text-xs text-zinc-600 dark:text-zinc-400"
      summary={
        <>
          <span className="font-semibold uppercase tracking-wide text-zinc-500">source</span>
          <span className="truncate font-mono text-zinc-500">{file.path}</span>
          <Link
            href={links.file(file)}
            className="ml-auto shrink-0 hover:text-sky-700 hover:underline dark:hover:text-sky-300"
          >
            open in setup
          </Link>
        </>
      }
    >
      <SourceView file={file} />
    </Disclosure>
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
    ([key]) =>
      key !== 'description' && key !== 'human' && !identity.some(k => k === key && typeof data?.[k] === 'string')
  );
  const isLead = ([key, value]: [string, unknown]) =>
    typeof value === 'string' && (lead.has(key) || value.includes('\n'));
  return (
    <LinksContext value={links}>
      <div className="space-y-5">
        <Header node={node} data={data ?? {}} />
        <Context node={node} />
        {data ? (
          <>
            {entries.filter(isLead).map(([key, value]) => (
              <Lead key={key} name={key} value={String(value)} />
            ))}
            {node.kind === 'note' && Array.isArray(data.notes) ? (
              <NoteList kind={node.label} notes={data.notes as Parameters<typeof NoteList>[0]['notes']} />
            ) : (
              <Properties path={[]} entries={entries.filter(entry => !isLead(entry))} />
            )}
          </>
        ) : (
          <Fallback node={node} />
        )}
        {data?.human !== undefined && <Human value={data.human} />}
        <Connections node={node} model={model} />
        {node.source && <NodeSource source={node.source} />}
      </div>
    </LinksContext>
  );
};
