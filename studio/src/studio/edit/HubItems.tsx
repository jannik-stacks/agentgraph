import { useAtomValue, useSetAtom } from 'jotai';
import { hubFile } from '../../../../src/config.ts';
import { type ItemKind, itemKind, itemName, noteKindOf, parseItem } from '../../../../src/hub-files.ts';
import { NoteKind } from '../../../../src/schema.ts';
import { navigateAtom } from '../../state.ts';
import { cx } from '../../ui.tsx';
import { createItemAtom, draftHubAtom, draftsAtom } from './hub-edits.ts';
import { itemDot } from './ItemEditor.tsx';

const groups: { kind: ItemKind; title: string; hint: string }[] = [
  { kind: 'workflow', title: 'workflows', hint: 'triggers to jobs' },
  { kind: 'bot', title: 'bots', hint: 'who acts' },
  { kind: 'skill', title: 'skills', hint: 'what to do' },
  { kind: 'check', title: 'checks', hint: 'verdicts that gate work' },
  { kind: 'note', title: 'notes', hint: 'what the hub knows' },
  { kind: 'issue', title: 'issues', hint: 'local issues' },
];

const add =
  'rounded border border-dashed border-zinc-300 px-1.5 text-[11px] leading-5 text-zinc-500 hover:border-sky-400 hover:text-sky-700 dark:border-zinc-700 dark:hover:border-sky-600 dark:hover:text-sky-300';

const title = (path: string, source: string) => {
  try {
    const t = parseItem(path, source).data.title;
    return typeof t === 'string' && t ? t : undefined;
  } catch {}
};

/** Every item in the hub by kind, each opening its editor, with a way to add one of each kind. */
export const HubItems = () => {
  const hub = useAtomValue(draftHubAtom);
  const drafts = useAtomValue(draftsAtom);
  const create = useSetAtom(createItemAtom);
  const navigate = useSetAtom(navigateAtom);
  if (!hub) return <p className="text-zinc-500">Loading the hub.</p>;
  const edit = (path: string) => navigate({ path: '/studio', query: { edit: path, node: null } });
  const hasHub = hub.files.some(f => f.path === hubFile);
  return (
    <div className="space-y-4">
      <header className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">Hub</h2>
        <p className="text-xs text-zinc-500">Select a node for its details, or edit any item here.</p>
      </header>
      <button
        type="button"
        onClick={() => (hasHub ? edit(hubFile) : create({ kind: 'hub' }))}
        className="flex w-full items-center gap-2 rounded border border-zinc-200 px-2 py-1 text-left text-xs hover:border-sky-400 dark:border-zinc-800 dark:hover:border-sky-700"
      >
        <span className={cx('size-1.5 rounded-full', itemDot('hub'))} />
        <span className="font-mono">hub.yaml</span>
        <span className="text-zinc-500">{hasHub ? 'hub settings' : 'add hub settings'}</span>
      </button>
      {groups.map(group => {
        const files = hub.files.filter(f => itemKind(f.path) === group.kind);
        return (
          <section key={group.kind} className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{group.title}</h3>
              <span className="text-[11px] text-zinc-400">{group.hint}</span>
              <span className="ml-auto flex gap-1">
                {group.kind === 'note' ? (
                  NoteKind.options.map(note => (
                    <button key={note} type="button" className={add} onClick={() => create({ kind: 'note', note })}>
                      + {note}
                    </button>
                  ))
                ) : (
                  <button type="button" className={add} onClick={() => create({ kind: group.kind })}>
                    + {group.kind}
                  </button>
                )}
              </span>
            </div>
            {files.length ? (
              <ul className="divide-y divide-zinc-100 rounded border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                {files.map(f => (
                  <li key={f.path}>
                    <button
                      type="button"
                      onClick={() => edit(f.path)}
                      className="flex w-full items-center gap-2 px-2 py-1 text-left text-[13px] hover:bg-zinc-50 dark:hover:bg-zinc-900"
                    >
                      <span className={cx('size-1.5 shrink-0 rounded-full', itemDot(group.kind))} />
                      <span className="truncate font-medium">{title(f.path, f.source) ?? itemName(f.path)}</span>
                      {group.kind === 'note' && <span className="text-[11px] text-zinc-500">{noteKindOf(f.path)}</span>}
                      {drafts[f.path] && (
                        <span className="ml-auto size-1.5 shrink-0 rounded-full bg-amber-500" title="pending change" />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-zinc-400">None yet.</p>
            )}
          </section>
        );
      })}
    </div>
  );
};
