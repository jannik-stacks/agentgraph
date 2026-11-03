import { useAtom, useAtomValue } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import { useEffect, useMemo, useRef } from 'react';
import { dataParam, queryParam, runAtom } from '../state.ts';
import { Live, Muted } from '../ui.tsx';
import { Rows, runRow } from './rows.tsx';
import { type ServedRun, lineAt } from './trace.ts';

const atParam = queryParam('at');
const expandAtom = atomWithStorage('agentgraph.expandSessions', true, undefined, { getOnInit: true });

/** One run opened with every trace line, scrolled to the line `?at=` names or following a running run. */
export const RunPage = ({ id }: { id: string }) => {
  const data = useAtomValue(dataParam);
  return (
    <Live state={useAtomValue(runAtom(id, data))}>
      {r => (r ? <OpenedRun r={r} /> : <Muted>No run {id} in this data dir.</Muted>)}
    </Live>
  );
};

const OpenedRun = ({ r }: { r: ServedRun }) => {
  const [expand, setExpand] = useAtom(expandAtom);
  const at = useAtomValue(atParam);
  const target = useMemo(() => lineAt(r.trace, at), [r, at]);
  const end = useRef<HTMLDivElement>(null);
  const following = expand && r.run.status === 'running' && !target;
  useEffect(() => {
    if (!target) return;
    document.querySelector('[data-target]')?.scrollIntoView({ block: 'center' });
  }, [at, !!target]);
  useEffect(() => {
    if (!following) return;
    for (const box of document.querySelectorAll('[data-scroll]')) box.scrollTop = box.scrollHeight;
    end.current?.scrollIntoView({ block: 'end' });
  }, [following, r]);
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
