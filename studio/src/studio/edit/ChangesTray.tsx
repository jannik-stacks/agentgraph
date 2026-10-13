import { useAtomValue, useSetAtom } from 'jotai';
import { useState } from 'react';
import { commitMessage } from '../../../../src/hub-files.ts';
import { Button, cx, Tooltip } from '../../ui.tsx';
import { diffLines, hunks } from './diff.ts';
import { discardAtom, draftHubAtom, editItemAtom, saveAtom, saveResultAtom, savingAtom } from './hub-edits.ts';

const FileDiff = ({ before, after }: { before: string; after: string }) => (
  <pre className="overflow-x-auto bg-white font-mono text-[11px] leading-[1.45] dark:bg-zinc-950">
    {hunks(diffLines(before, after)).map((line, i) =>
      line === null ? (
        <div key={i} className="select-none bg-zinc-50 px-2 text-zinc-400 dark:bg-zinc-900">
          ⋯
        </div>
      ) : (
        <div
          key={i}
          className={cx(
            'px-2',
            line.type === 'add' && 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200',
            line.type === 'del' && 'bg-red-50 text-red-900 dark:bg-red-950/60 dark:text-red-200'
          )}
        >
          <span className="mr-2 select-none text-zinc-400">
            {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
          </span>
          {line.text}
        </div>
      )
    )}
  </pre>
);

/** Pending edits with a diff per file, their problems, and the actions that write them to the hub. */
export const ChangesTray = () => {
  const hub = useAtomValue(draftHubAtom);
  const saving = useAtomValue(savingAtom);
  const result = useAtomValue(saveResultAtom);
  const setResult = useSetAtom(saveResultAtom);
  const save = useSetAtom(saveAtom);
  const discard = useSetAtom(discardAtom);
  const edit = useSetAtom(editItemAtom);
  const [open, setOpen] = useState(false);
  if (!hub) return null;
  const { changes, validated } = hub;
  if (!changes.length && !result) return null;
  const before = new Map(hub.before.map(f => [f.path, f.source]));
  const after = new Map(hub.files.map(f => [f.path, f.source]));
  const errors = validated.errors;
  return (
    <div className="border-t border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/70">
      <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-xs">
        {changes.length > 0 ? (
          <button
            type="button"
            className="font-medium hover:underline"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? '▾' : '▸'} {changes.length} pending {changes.length === 1 ? 'change' : 'changes'}
          </button>
        ) : null}
        {changes.length > 0 &&
          (errors.length ? (
            <span className="rounded bg-red-100 px-1.5 text-red-700 dark:bg-red-950 dark:text-red-300">
              {errors.length} {errors.length === 1 ? 'problem' : 'problems'}, nothing can be saved until the hub
              compiles
            </span>
          ) : (
            <span className="text-emerald-700 dark:text-emerald-400">the hub compiles</span>
          ))}
        {result && (
          <span
            className={
              result.ok && !result.commitError
                ? 'text-emerald-700 dark:text-emerald-400'
                : 'text-red-700 dark:text-red-400'
            }
          >
            {result.ok
              ? result.commit
                ? `saved and committed ${result.commit.slice(0, 7)}`
                : result.commitError
                  ? `saved, but the commit failed: ${result.commitError}`
                  : 'saved'
              : `not saved: ${result.errors.map(e => (e.path ? `${e.path} ${e.message}` : e.message)).join('; ')}`}
            <button
              type="button"
              className="ml-1.5 text-zinc-400 hover:text-zinc-700"
              aria-label="dismiss"
              onClick={() => setResult(undefined)}
            >
              ×
            </button>
          </span>
        )}
        {changes.length > 0 && (
          <span className="ml-auto flex gap-1.5">
            <Button onClick={() => discard()}>Discard all</Button>
            <Button
              variant={hub.git ? 'default' : 'primary'}
              disabled={!validated.ok || saving}
              onClick={() => void save({})}
            >
              Save
            </Button>
            {hub.git && (
              <Tooltip tip={`Writes the files and commits just those files as "${commitMessage}"`}>
                <Button
                  variant="primary"
                  disabled={!validated.ok || saving}
                  onClick={() => void save({ commit: true })}
                >
                  Save and commit
                </Button>
              </Tooltip>
            )}
          </span>
        )}
      </div>
      {open && changes.length > 0 && (
        <div className="max-h-[42vh] space-y-2 overflow-y-auto px-3 pb-3">
          {errors.length > 0 && (
            <ul className="space-y-1 text-xs">
              {errors.map((e, i) => (
                <li
                  key={i}
                  className="rounded border border-red-200 bg-white px-2 py-1 dark:border-red-900 dark:bg-zinc-950"
                >
                  <button
                    type="button"
                    className="mr-2 font-mono text-sky-700 hover:underline dark:text-sky-400"
                    onClick={() => edit(e.path)}
                  >
                    {e.path}
                  </button>
                  <span className="whitespace-pre-wrap text-red-800 dark:text-red-300">{e.message}</span>
                </li>
              ))}
            </ul>
          )}
          {changes.map(change => {
            const was = before.get(change.path);
            const now = after.get(change.path);
            const status = now === undefined ? 'deleted' : was === undefined ? 'new' : 'edited';
            return (
              <div key={change.path} className="overflow-hidden rounded border border-zinc-200 dark:border-zinc-800">
                <div className="flex items-center gap-2 border-b border-zinc-200 bg-white px-2 py-1 text-xs dark:border-zinc-800 dark:bg-zinc-900">
                  <span
                    className={cx(
                      'rounded px-1.5',
                      status === 'new' && 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
                      status === 'edited' && 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
                      status === 'deleted' && 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300'
                    )}
                  >
                    {status}
                  </span>
                  {status === 'deleted' ? (
                    <span className="font-mono">{change.path}</span>
                  ) : (
                    <button
                      type="button"
                      className="font-mono hover:text-sky-700 hover:underline dark:hover:text-sky-300"
                      onClick={() => edit(change.path)}
                    >
                      {change.path}
                    </button>
                  )}
                  <button
                    type="button"
                    className="ml-auto text-zinc-500 hover:text-red-600"
                    onClick={() => discard(change.path)}
                  >
                    discard
                  </button>
                </div>
                <FileDiff before={was ?? ''} after={now ?? ''} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
