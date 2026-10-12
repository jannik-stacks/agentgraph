import { useAtomValue, useSetAtom } from 'jotai';
import { useMemo } from 'react';
import { NoteKind } from '../../../src/schema.ts';
import type { GraphModel } from '../graph-model.ts';
import { editPathAtom, navigateAtom, sampleAtom } from '../state.ts';
import { Badge, Chip, cx, Muted } from '../ui.tsx';
import { ChangesTray } from './edit/ChangesTray.tsx';
import { createItemAtom } from './edit/hub-edits.ts';
import { ItemEditor } from './edit/ItemEditor.tsx';
import { useHubModel } from './hub-model.ts';
import { StudioLayout } from './StudioLayout.tsx';
import { kindDot } from './styles.ts';

/** For each note path, the steps and the bots that load it. */
const loaders = (model: GraphModel) => {
  const found = new Map<string, { steps: Set<string>; bots: Set<string> }>();
  for (const node of model.nodes)
    for (const context of node.context ?? []) {
      if (context.step !== node.id) continue;
      for (const { note } of context.notes) {
        const entry = found.get(note.path) ?? { steps: new Set(), bots: new Set() };
        entry.steps.add(context.step);
        entry.bots.add(context.bot);
        found.set(note.path, entry);
      }
    }
  return found;
};

const add =
  'rounded border border-dashed border-zinc-300 px-1.5 text-[11px] leading-5 text-zinc-500 hover:border-sky-400 hover:text-sky-700 dark:border-zinc-700 dark:hover:border-sky-600 dark:hover:text-sky-300';

const Notes = () => {
  const { model, config } = useHubModel();
  const edit = useAtomValue(editPathAtom);
  const navigate = useSetAtom(navigateAtom);
  const create = useSetAtom(createItemAtom);
  const loaded = useMemo(() => (model ? loaders(model) : undefined), [model]);
  if (!model || !config) return <Muted>The hub does not compile yet; fix it under Graph.</Muted>;
  const labelOf = (id: string) => model.nodes.find(n => n.id === id)?.label ?? id.replace(/^[a-z]+:/, '');
  const open = (id: string) => ({
    href: `/studio?node=${encodeURIComponent(id)}`,
    onClick: () => navigate({ path: '/studio', query: { node: id, edit: null } }),
  });
  return (
    <StudioLayout
      aside={
        edit ? (
          <ItemEditor path={edit} model={model} />
        ) : (
          <p className="text-zinc-500">
            Select a note to edit it. A step loads a decision or convention whenever its paths match, and a pattern or
            caveat when its bot or skill lists the kind or its paths match the step.
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
                <span className={cx('size-2 rounded-full', kindDot.note)} />
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
                    const by = loaded?.get(note.path);
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
                          {note.paths?.map(path => (
                            <Chip key={path} mono>
                              {path}
                            </Chip>
                          ))}
                        </div>
                        <div className="flex flex-wrap items-center gap-1 text-xs text-zinc-500">
                          {by ? (
                            <>
                              loaded by
                              {[...by.steps, ...by.bots].map(id => (
                                <Chip
                                  key={id}
                                  dot={
                                    kindDot[id.startsWith('bot:') ? 'bot' : id.startsWith('check:') ? 'check' : 'job']
                                  }
                                  {...open(id)}
                                >
                                  {labelOf(id)}
                                </Chip>
                              ))}
                            </>
                          ) : (
                            'loaded by no step; runs with notes_search can still find it'
                          )}
                        </div>
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

/** Every note by kind with the steps and bots that load it, each opening in the editor. */
export const NotesView = () =>
  useAtomValue(sampleAtom) ? <Muted>The sample graph has no notes. Open a hub to browse them.</Muted> : <Notes />;
