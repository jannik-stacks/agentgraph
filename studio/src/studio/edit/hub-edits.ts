import { atom, useSetAtom } from 'jotai';
import { atomWithRefresh, unwrap } from 'jotai/utils';
import type { SourceFile } from '../../../../src/config.ts';
import {
  applyChanges,
  type Change,
  type HubItem,
  type ItemKind,
  itemKinds,
  newItem,
  parseItem,
  renameItem,
  renderItem,
  validateHub,
} from '../../../../src/hub-files.ts';
import type { HubItems, WriteResult } from '../../../../src/hub-write.ts';
import type { NoteKind } from '../../../../src/schema.ts';
import { filesQueryAtom, hubAtom, navigateAtom } from '../../state.ts';

const getItems = async (): Promise<HubItems> => {
  const response = await fetch('/api/hub/items');
  if (!response.ok) throw new Error(`/api/hub/items answered ${response.status}`);
  return response.json() as Promise<HubItems>;
};

export const itemsQueryAtom = atomWithRefresh(getItems);
/** The hub's item files as they are on disk, and whether the hub is in git. */
export const itemsAtom = unwrap(itemsQueryAtom, previous => previous);

/** Pending edits by path, not yet written. */
export const draftsAtom = atom<Record<string, Change>>({});

/** The hub as it would be with the pending edits: its files, validation and compiled config. */
export const draftHubAtom = atom(get => {
  const items = get(itemsAtom);
  if (!items) return undefined;
  const changes = Object.values(get(draftsAtom));
  const files = applyChanges(items.files, changes);
  return { before: items.files, files, changes, git: items.git, validated: validateHub(files) };
});

const source = (files: SourceFile[], path: string) => files.find(f => f.path === path)?.source;

const parsed = new Map<string, HubItem | null>();

/** An item parsed from its source, cached by path and source; `null` when it does not parse. */
export const parseCached = (path: string, text: string) => {
  const key = `${path}\0${text}`;
  let item = parsed.get(key);
  if (item === undefined) {
    if (parsed.size > 1000) parsed.clear();
    try {
      item = parseItem(path, text);
    } catch {
      item = null;
    }
    parsed.set(key, item);
  }
  return item;
};

/** An item as it would be with the pending edits, or `undefined` when there is no such file. */
export const draftItem = (files: SourceFile[], path: string): HubItem | undefined => {
  const text = source(files, path);
  if (text === undefined) return;
  return parseCached(path, text) ?? { data: {}, body: text };
};

const stage = (drafts: Record<string, Change>, disk: SourceFile[], changes: Change[]) => {
  const next = { ...drafts };
  for (const change of changes) {
    const original = source(disk, change.path);
    const same =
      'delete' in change
        ? original === undefined
        : original !== undefined &&
          renderItem(change.path, { data: change.data, body: change.body ?? '' }, original) === original;
    if (same) delete next[change.path];
    else next[change.path] = change;
  }
  return next;
};

/** Stages edits: each is kept until saved or discarded, and dropped again once it matches the file on disk. */
export const stageAtom = atom(null, (get, set, changes: Change | Change[]) => {
  const items = get(itemsAtom);
  if (!items) return;
  set(draftsAtom, stage(get(draftsAtom), items.files, [changes].flat()));
});

/** Stages an item's new frontmatter, keeping its current body unless one is given. */
export const stageItemAtom = atom(
  null,
  (get, set, { path, data, body }: { path: string; data: Record<string, unknown>; body?: string }) => {
    const hub = get(draftHubAtom);
    if (!hub) return;
    set(stageAtom, { path, data, body: body ?? draftItem(hub.files, path)?.body ?? '' });
  }
);

export const discardAtom = atom(null, (get, set, path?: string) => {
  if (path === undefined) return set(draftsAtom, {});
  const { [path]: _, ...rest } = get(draftsAtom);
  set(draftsAtom, rest);
});

/** Opens an item's editor in the studio. */
export const editItemAtom = atom(null, (_get, set, path: string) =>
  set(navigateAtom, { path: '/studio', query: { edit: path, node: null } })
);

/** Stages a new item of `kind` with the smallest valid frontmatter its schema allows, and opens it for editing. */
export const createItemAtom = atom(null, (get, set, { kind, note }: { kind: ItemKind; note?: NoteKind }) => {
  const hub = get(draftHubAtom);
  if (!hub) return;
  const item = newItem(hub.files, kind, note);
  set(stageAtom, item);
  set(editItemAtom, item.path);
});

/** Moves an item to a new path and points every reference to its old name at the new one. */
export const renameItemAtom = atom(null, (get, set, { from, to }: { from: string; to: string }) => {
  const hub = get(draftHubAtom);
  const renamed = hub && renameItem(hub.files, from, to);
  if (!renamed?.ok || !renamed.changes.length) return;
  set(stageAtom, renamed.changes);
  set(navigateAtom, { query: { edit: to } });
});

export const deleteItemAtom = atom(null, (_get, set, path: string) => {
  set(stageAtom, { path, delete: true });
  set(navigateAtom, { query: { edit: null } });
});

export const savingAtom = atom(false);
export const saveResultAtom = atom<WriteResult | Omit<Extract<WriteResult, { ok: false }>, 'status'> | undefined>(
  undefined
);

/** Writes every pending edit, validated again by the server, and commits them as `update` when asked. */
export const saveAtom = atom(null, async (get, set, { commit = false }: { commit?: boolean } = {}) => {
  const hub = get(draftHubAtom);
  if (!hub || !hub.changes.length || get(savingAtom)) return;
  set(savingAtom, true);
  try {
    const changes = hub.changes.map(change => ({ ...change, base: source(hub.before, change.path) ?? null }));
    const response = await fetch('/api/hub/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changes, commit }),
    });
    const result = (await response.json()) as WriteResult & { error?: string };
    if (result.error) return set(saveResultAtom, { ok: false, errors: [{ path: '', message: result.error }] });
    set(saveResultAtom, result);
    if (!result.ok) return;
    set(draftsAtom, {});
    set(itemsQueryAtom);
    set(hubAtom);
    set(filesQueryAtom);
  } catch (e) {
    set(saveResultAtom, { ok: false, errors: [{ path: '', message: (e as Error).message }] });
  } finally {
    set(savingAtom, false);
  }
});

/**
 * Editing hooks for other studio views, such as the graph: `stageItem` stages an item's new frontmatter (a whole
 * workflow, say) as a pending edit, `save` writes all pending edits.
 */
export const useHubEdits = () => ({
  stageItem: useSetAtom(stageItemAtom),
  save: useSetAtom(saveAtom),
});

export const kindLabel = (kind: ItemKind) => (kind === 'hub' ? 'hub settings' : kind);
export const bodyLabel = (kind: ItemKind) => itemKinds[kind].body;
