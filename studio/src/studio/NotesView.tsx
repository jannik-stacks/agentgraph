import { useAtomValue, useSetAtom } from 'jotai';
import { accepted } from '../../../src/preload.ts';
import { NoteKind } from '../../../src/schema.ts';
import { editPathAtom, hrefAtom, navigateAtom } from '../state.ts';
import { Badge, Chip, cx, Muted } from '../ui.tsx';
import { ChangesTray } from './edit/ChangesTray.tsx';
import { createItemAtom } from './edit/hub-edits.ts';
import { ItemEditor } from './edit/ItemEditor.tsx';
import { useHubModel } from './hub-model.ts';
import { StudioLayout } from './StudioLayout.tsx';
import { nodeTarget } from './hub-refs.ts';
import { KindIcon } from './icons.tsx';

const add =
  'rounded border border-dashed border-zinc-300 px-1.5 text-[11px] leading-5 text-zinc-500 hover:border-sky-400 hover:text-sky-700 dark:border-zinc-700 dark:hover:border-sky-600 dark:hover:text-sky-300';

/** Every note by kind, each opening in the editor. */
export const NotesView = () => {
  const { model, config } = useHubModel();
  const edit = useAtomValue(editPathAtom);
  const navigate = useSetAtom(navigateAtom);
  const create = useSetAtom(createItemAtom);
  if (!model || !config) return <Muted>The hub does not compile yet; fix it under Graph.</Muted>;
  const href = useAtomValue(hrefAtom);
  return (
    <StudioLayout
      aside={
        edit ? (
          <ItemEditor path={edit} model={model} />
        ) : (
          <p className="text-zinc-500">
            Select a note to edit it. Notes are what the hub knows. Accepted notes are surfaced by relevance while a bot
            works, and every run can find them with notes_search; proposed ones wait for a human.
          </p>
        )
      }
      footer={<ChangesTray />}
    >
      <div className="h-full space-y-6 overflow-y-auto p-4">
        {NoteKind.options.map(kind => {
          const notes = config.notes.filter(n => n.kind === kind);
          return (
            <section key={kind} className="space-y-1.5">
              <div className="flex items-center gap-2">
                <KindIcon kind="note" />
                <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{kind}</h2>
                <span className="text-[11px] text-zinc-400">{notes.length}</span>
                <button
                  type="button"
                  className={cx(add, 'ml-auto')}
                  onClick={() => create({ kind: 'note', note: kind })}
                >
                  + {kind}
                </button>
              </div>
              {notes.length ? (
                <ul className="divide-y divide-zinc-100 rounded border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                  {notes.map(note => {
                    return (
                      <li
                        key={note.path}
                        className={cx('space-y-1 px-3 py-2', note.path === edit && 'bg-sky-50 dark:bg-sky-950/40')}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            className="font-medium hover:text-sky-700 hover:underline dark:hover:text-sky-300"
                            onClick={() => navigate({ query: { edit: note.path } })}
                          >
                            {note.title}
                          </button>
                          <span className="font-mono text-[11px] text-zinc-500">{note.name}</span>
                          {note.status && (
                            <Badge tone={note.status === 'accepted' ? 'ok' : 'neutral'}>{note.status}</Badge>
                          )}
                          {note.check && (
                            <Chip
                              icon={<KindIcon kind="check" className="size-3" title="" />}
                              title="The check that keeps this note true"
                              action="Show the check"
                              href={href(nodeTarget(`check:${note.check}`))}
                            >
                              {note.check}
                            </Chip>
                          )}
                        </div>
                        {!accepted(note) && (
                          <p className="text-xs text-zinc-500">{note.status}, so it is not surfaced</p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-xs text-zinc-500">No {kind} notes yet.</p>
              )}
            </section>
          );
        })}
      </div>
    </StudioLayout>
  );
};
