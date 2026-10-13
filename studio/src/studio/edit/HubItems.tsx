import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { hubFile } from '../../../../src/config.ts';
import { type ItemKind, itemKind, itemName, noteKindOf } from '../../../../src/hub-files.ts';
import { NoteKind } from '../../../../src/schema.ts';
import { listKindAtom } from '../../state.ts';
import { Button, Tooltip } from '../../ui.tsx';
import { ItemList, type Row, RowPreview } from '../ItemList.tsx';
import { createItemAtom, draftHubAtom, draftsAtom, editItemAtom, parseCached } from './hub-edits.ts';
import { KindIcon } from '../icons.tsx';
import { itemIcon } from './ItemEditor.tsx';

const groups: { kind: ItemKind; title: string; hint: string }[] = [
  { kind: 'workflow', title: 'workflows', hint: 'triggers to jobs' },
  { kind: 'bot', title: 'bots', hint: 'who acts' },
  { kind: 'skill', title: 'skills', hint: 'what to do' },
  { kind: 'check', title: 'checks', hint: 'verdicts that gate work' },
  { kind: 'note', title: 'notes', hint: 'what the hub knows' },
  { kind: 'issue', title: 'issues', hint: 'local issues' },
];

const title = (path: string, source: string) => {
  const t = parseCached(path, source)?.data.title;
  return typeof t === 'string' && t ? t : undefined;
};

/**
 * The items in the hub by kind, each opening its editor, with a way to add one of each kind. Long kinds show their
 * first few and open in a full list of their own.
 */
export const HubItems = () => {
  const hub = useAtomValue(draftHubAtom);
  const drafts = useAtomValue(draftsAtom);
  const create = useSetAtom(createItemAtom);
  const edit = useSetAtom(editItemAtom);
  const [list, setList] = useAtom(listKindAtom);
  if (!hub) return <p className="text-zinc-500">Loading the hub.</p>;
  const rowsOf = (kind: ItemKind) =>
    hub.files
      .filter(f => itemKind(f.path) === kind)
      .map((f): Row => ({
        key: f.path,
        label: title(f.path, f.source) ?? itemName(f.path),
        icon: <KindIcon kind={itemIcon(kind)} />,
        search: f.path,
        meta: (
          <>
            {kind === 'note' && <span className="text-[11px] text-zinc-500">{noteKindOf(f.path)}</span>}
            {drafts[f.path] && (
              <Tooltip tip="Unsaved change" className="ml-auto shrink-0">
                <span className="size-1.5 rounded-full bg-amber-500" />
              </Tooltip>
            )}
          </>
        ),
        onPick: () => edit(f.path),
      }));
  const open = groups.find(group => group.kind === list);
  if (open) return <ItemList title={open.title} rows={rowsOf(open.kind)} onBack={() => setList(null)} />;
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
        <KindIcon kind="hub" />
        <span className="font-mono">hub.yaml</span>
        <span className="text-zinc-500">{hasHub ? 'hub settings' : 'add hub settings'}</span>
      </button>
      {groups.map(group => {
        const rows = rowsOf(group.kind);
        return (
          <section key={group.kind} className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{group.title}</h3>
              <span className="text-[11px] text-zinc-400">{group.hint}</span>
              <span className="ml-auto flex gap-1">
                {group.kind === 'note' ? (
                  NoteKind.options.map(note => (
                    <Button key={note} variant="dashed" onClick={() => create({ kind: 'note', note })}>
                      + {note}
                    </Button>
                  ))
                ) : (
                  <Button variant="dashed" onClick={() => create({ kind: group.kind })}>
                    + {group.kind}
                  </Button>
                )}
              </span>
            </div>
            {rows.length ? (
              <RowPreview rows={rows} onShowAll={() => setList(group.kind)} />
            ) : (
              <p className="text-xs text-zinc-400">None yet.</p>
            )}
          </section>
        );
      })}
    </div>
  );
};
