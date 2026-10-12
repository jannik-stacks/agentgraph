import { useAtomValue, useSetAtom } from 'jotai';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { harnessToolNames } from '../../../../src/config.ts';
import {
  fieldIssues,
  itemKind,
  itemName,
  itemPath,
  itemSchema,
  noteKindOf,
  parseItem,
  type ItemKind,
} from '../../../../src/hub-files.ts';
import { Harness, HubTool, NoteKind } from '../../../../src/schema.ts';
import type { GraphModel, NodeKind } from '../../graph-model.ts';
import { filesAtom, navigateAtom, selectedNodeAtom } from '../../state.ts';
import { cx } from '../../ui.tsx';
import { kindDot } from '../styles.ts';
import {
  bodyLabel,
  deleteItemAtom,
  discardAtom,
  draftHubAtom,
  draftItem,
  draftsAtom,
  kindLabel,
  renameItemAtom,
  stageAtom,
} from './hub-edits.ts';
import { type FormContext, type Path, SchemaForm } from './SchemaForm.tsx';

const Markdown = lazy(() => import('../Markdown.tsx'));

const button =
  'rounded border border-zinc-300 px-2 py-0.5 text-xs text-zinc-700 hover:border-sky-400 hover:text-sky-700 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-sky-600 dark:hover:text-sky-300';

const refKinds: Record<string, NodeKind> = {
  bot: 'bot',
  skill: 'skill',
  skills: 'skill',
  check: 'check',
  checks: 'check',
  tools: 'tool',
  subagents: 'bot',
};

const kindOfItem: Partial<Record<ItemKind, NodeKind>> = { bot: 'bot', skill: 'skill', check: 'check', workflow: 'trigger', note: 'note', issue: 'issues', hub: 'issues' };
export const itemDot = (kind: ItemKind) => kindDot[kindOfItem[kind] ?? 'job'];

const modelAliases = (sources: { path: string; source: string }[]) =>
  [
    ...new Set(
      sources
        .filter(f => /litellm[^/]*\.ya?ml$/.test(f.path))
        .flatMap(f => [...f.source.matchAll(/model_name:\s*(\S+)/g)].map(m => m[1]!))
    ),
  ].sort();

const lastKey = (path: Path) => String(path.findLast(p => typeof p === 'string') ?? '');

const NameInput = ({ path, kind }: { path: string; kind: ItemKind }) => {
  const rename = useSetAtom(renameItemAtom);
  const hub = useAtomValue(draftHubAtom);
  const name = itemName(path);
  const [text, setText] = useState(name);
  useEffect(() => setText(name), [name]);
  const problemOf = (text: string) => {
    const target = itemPath(kind, text, noteKindOf(path));
    return text === name
      ? undefined
      : itemKind(target) !== kind
        ? kind === 'issue'
          ? 'a number, a dash and a lowercase slug'
          : 'lowercase letters, digits and dashes, starting with a letter'
        : hub?.files.some(f => f.path === target)
          ? 'that name is taken'
          : undefined;
  };
  const problem = problemOf(text);
  const commit = (value: string) =>
    problemOf(value) || value === name ? setText(name) : rename({ from: path, to: itemPath(kind, value, noteKindOf(path)) });
  return (
    <div>
      <input
        aria-label="name"
        className={cx(
          'w-full rounded border bg-transparent px-1.5 py-0.5 text-lg font-semibold outline-none focus:border-sky-500',
          problem ? 'border-red-400' : 'border-transparent hover:border-zinc-300 dark:hover:border-zinc-700'
        )}
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') commit(e.currentTarget.value);
          if (e.key === 'Escape') setText(name);
        }}
        onBlur={e => commit(e.currentTarget.value)}
      />
      {problem && <p className="px-1.5 text-[11px] text-red-600 dark:text-red-400">{problem}</p>}
    </div>
  );
};

const BodyEditor = ({ label, body, onChange }: { label: string; body: string; onChange: (body: string) => void }) => {
  const [preview, setPreview] = useState(false);
  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{label}</h3>
        <div className="ml-auto inline-flex gap-0.5 rounded-md bg-zinc-100 p-0.5 text-xs dark:bg-zinc-800/80">
          {(['write', 'preview'] as const).map(mode => (
            <button
              key={mode}
              type="button"
              aria-pressed={(mode === 'preview') === preview}
              onClick={() => setPreview(mode === 'preview')}
              className={cx(
                'rounded px-2 py-0.5 capitalize',
                (mode === 'preview') === preview ? 'bg-white shadow-sm dark:bg-zinc-600' : 'text-zinc-500'
              )}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>
      {preview ? (
        <div className="min-h-24 rounded-lg border border-zinc-200 bg-zinc-50/70 px-3.5 py-3 dark:border-zinc-800 dark:bg-zinc-900/60">
          {body.trim() ? (
            <Suspense fallback={<p className="whitespace-pre-wrap text-[13px]">{body}</p>}>
              <Markdown text={body} />
            </Suspense>
          ) : (
            <p className="text-zinc-400">Nothing written yet.</p>
          )}
        </div>
      ) : (
        <textarea
          aria-label={label}
          className="min-h-48 w-full rounded border border-zinc-300 bg-white p-2 font-mono text-xs leading-relaxed outline-none focus:border-sky-500 dark:border-zinc-700 dark:bg-zinc-900"
          value={body}
          rows={Math.min(30, Math.max(8, body.split('\n').length + 2))}
          onChange={e => onChange(e.target.value)}
        />
      )}
    </section>
  );
};

/** The form for one hub file: its name, every frontmatter field from the kind's schema, and its Markdown body. */
export const ItemEditor = ({ path, model }: { path: string; model: GraphModel | undefined }) => {
  const hub = useAtomValue(draftHubAtom);
  const drafts = useAtomValue(draftsAtom);
  const files = useAtomValue(filesAtom);
  const selected = useAtomValue(selectedNodeAtom);
  const stage = useSetAtom(stageAtom);
  const rename = useSetAtom(renameItemAtom);
  const remove = useSetAtom(deleteItemAtom);
  const discard = useSetAtom(discardAtom);
  const navigate = useSetAtom(navigateAtom);
  const kind = itemKind(path);
  const draft = drafts[path];
  const parsed = hub && draftItem(hub.files, path);
  const item = parsed && draft && 'data' in draft ? { data: draft.data, body: draft.body ?? parsed.body } : parsed;

  const context = useMemo((): FormContext | undefined => {
    if (!hub || !item || !kind) return;
    const named = (k: ItemKind) => hub.files.filter(f => itemKind(f.path) === k).map(f => itemName(f.path));
    const bots = named('bot');
    const harness = Harness.safeParse(item.data.harness).data;
    const tools = [...(harness ? harnessToolNames[harness] : [...new Set(Object.values(harnessToolNames).flat())]), ...HubTool.options];
    const labels = [
      ...new Set(
        hub.files
          .filter(f => itemKind(f.path) === 'issue')
          .flatMap(f => {
            try {
              const l = parseItem(f.path, f.source).data.labels;
              return Array.isArray(l) ? l.map(String) : [];
            } catch {
              return [];
            }
          })
      ),
    ];
    const jobs = Object.keys((item.data.jobs as Record<string, unknown> | undefined) ?? {});
    const workflowName = String(item.data.name ?? itemName(path));
    const [, focusWorkflow, focusJob] = /^(?:job|script):([^/]+)\/(.+)$/.exec(selected ?? '') ?? [];
    const nodes = new Set(model?.nodes.map(n => n.id));
    return {
      issues: fieldIssues(path, item.data),
      suggest: p => {
        const key = lastKey(p);
        if (key === 'bot') return bots;
        if (key === 'skill' || key === 'skills') return named('skill');
        if (key === 'check' || key === 'checks') return named('check');
        if (key === 'needs') return jobs.filter(j => j !== p[1]);
        if (key === 'tools') return tools;
        if (key === 'model') return modelAliases(files ?? []);
        if (key === 'labels') return labels;
        if (key === 'subagents') return [...bots.filter(b => b !== itemName(path)), 'explore', 'general'];
      },
      link: (p, value) => {
        const k = refKinds[lastKey(p)];
        if (k === 'tool' && !HubTool.safeParse(value).success) return;
        const id = k && `${k}:${value}`;
        if (!id || !nodes.has(id)) return;
        return {
          href: `/studio?node=${encodeURIComponent(id)}`,
          onClick: () => navigate({ path: '/studio', query: { node: id, edit: null } }),
          dot: kindDot[k],
        };
      },
      open: p => kind === 'workflow' && p.length === 2 && p[0] === 'jobs' && p[1] === focusJob && workflowName === focusWorkflow,
    };
  }, [hub, item, kind, path, files, selected, model, navigate]);

  if (!hub) return <p className="text-zinc-500">Loading the hub.</p>;
  if (!kind) return <p className="text-zinc-500">{path} is not a hub item.</p>;
  if (!item || !context)
    return (
      <div className="space-y-2">
        <p className="text-zinc-500">{path} is staged for deletion.</p>
        <button type="button" className={button} onClick={() => discard(path)}>
          Undo
        </button>
      </div>
    );

  const set = (data: Record<string, unknown>, body = item.body) => stage({ path, data, body });
  const status = drafts[path] ? (hub.before.some(f => f.path === path) ? 'edited' : 'new') : undefined;
  const errors = hub.validated.errors.filter(e => e.path === path && !e.message.startsWith('✖'));
  const warnings = hub.validated.warnings.filter(e => e.path === path);
  const label = bodyLabel(kind);

  return (
    <div className="space-y-4">
      <header className="space-y-1.5">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-zinc-500">
          <span className={cx('size-2 rounded-full', itemDot(kind))} />
          editing {kindLabel(kind)}
          {status && <span className="rounded bg-amber-100 px-1.5 normal-case tracking-normal text-amber-800 dark:bg-amber-950 dark:text-amber-300">{status}</span>}
          <span className="ml-auto flex gap-1.5 normal-case tracking-normal">
            {kind !== 'hub' && (
              <button type="button" className={cx(button, 'hover:border-red-400 hover:text-red-700 dark:hover:text-red-400')} onClick={() => remove(path)}>
                Delete
              </button>
            )}
            <button type="button" className={button} onClick={() => navigate({ query: { edit: null } })}>
              Done
            </button>
          </span>
        </div>
        {kind === 'hub' ? <h2 className="text-lg font-semibold">hub.yaml</h2> : <NameInput path={path} kind={kind} />}
        <div className="font-mono text-[11px] text-zinc-500">{path}</div>
        {kind === 'note' && (
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            kind
            <div className="inline-flex gap-0.5 rounded-md bg-zinc-100 p-0.5 dark:bg-zinc-800/80">
              {NoteKind.options.map(k => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={noteKindOf(path) === k}
                  onClick={() => rename({ from: path, to: itemPath('note', itemName(path), k) })}
                  className={cx('rounded px-2 py-0.5', noteKindOf(path) === k ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-600 dark:text-white' : '')}
                >
                  {k}
                </button>
              ))}
            </div>
          </div>
        )}
      </header>
      {(errors.length > 0 || warnings.length > 0) && (
        <ul className="space-y-1 text-xs">
          {errors.map(e => (
            <li key={e.message} className="rounded border border-red-200 bg-red-50 px-2 py-1 text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">
              {e.message}
            </li>
          ))}
          {warnings.map(e => (
            <li key={e.message} className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300">
              {e.message}
            </li>
          ))}
        </ul>
      )}
      <SchemaForm schema={itemSchema(kind)} value={item.data} onChange={data => set(data)} context={context} />
      {label && <BodyEditor label={label} body={item.body} onChange={body => set(item.data, body)} />}
    </div>
  );
};
