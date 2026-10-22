import { useAtom, useAtomValue } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import { useEffect, useMemo, useRef } from 'react';
import { queryParam, runAtom } from '../state.ts';
import { Loading, Muted } from '../ui.tsx';
import { Rows, runRow } from './rows.tsx';
import { lineAt } from './trace.ts';

const atParam = queryParam('at');
const expandAtom = atomWithStorage('agentgraph.expandSessions', true, undefined, { getOnInit: true });

/** One run opened with every trace line, scrolled to the line `?at=` names or following a running run. */
export const RunPage = ({ id }: { id: string }) => {
  const { value: r, failure } = useAtomValue(runAtom(id));
  const [expand, setExpand] = useAtom(expandAtom);
  const at = useAtomValue(atParam);
  const target = useMemo(() => (r ? lineAt(r.trace, at) : undefined), [r, at]);
  const end = useRef<HTMLDivElement>(null);
  const following = expand && r?.run.status === 'running' && !target;
  useEffect(() => {
    if (!target) return;
    document.querySelector('[data-target]')?.scrollIntoView({ block: 'center' });
  }, [at, !!target]);
  useEffect(() => {
    if (!following) return;
    for (const box of document.querySelectorAll('[data-scroll]')) box.scrollTop = box.scrollHeight;
    end.current?.scrollIntoView({ block: 'end' });
  }, [following, r]);
  if (r === undefined) return failure ? <Muted>{failure}</Muted> : <Loading />;
  if (r === null) return <Muted>No run {id} in this data dir.</Muted>;
  return (
    <>
      <label className="flex w-fit items-center gap-1.5 text-xs text-zinc-500">
        <input type="checkbox" checked={expand} onChange={e => setExpand(e.target.checked)} />
        Open every session{r.run.status === 'running' && ' and follow the newest events'}
      </label>
      <Rows rows={[runRow(r, true, expand, target)]} />
      <div ref={end} />
    </>
  );
};
