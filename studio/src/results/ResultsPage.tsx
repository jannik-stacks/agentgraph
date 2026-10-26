import { useAtom, useAtomValue } from 'jotai';
import { lazy, Suspense, useMemo } from 'react';
import { queryParam, resultsAtoms } from '../state.ts';
import { Button, cx, Loading, Muted, Select } from '../ui.tsx';
import { Candidate } from './Candidate.tsx';
import { type ResultSource, resultSources } from './result.ts';
import { ResultTable } from './ResultTable.tsx';

const ResultChart = lazy(() => import('./ResultChart.tsx'));

const params = Object.fromEntries(
  ['from', 'view', 'by', 'trend', 'dead', 'y', 'x', 'color', 'facet', 'run', 'pick'].map(k => [k, queryParam(k)])
) as Record<
  'from' | 'view' | 'by' | 'trend' | 'dead' | 'y' | 'x' | 'color' | 'facet' | 'run' | 'pick',
  ReturnType<typeof queryParam>
>;

const defaults: Record<ResultSource, { x: string; color: string }> = {
  runs: { x: 'time', color: 'workflow' },
  bench: { x: 'point', color: 'model' },
  tune: { x: 'iteration', color: 'tune' },
};

const key = (f: { check: string; field: string }) => `${f.check} ${f.field}`;

const Data = ({ from }: { from: ResultSource }) => {
  const { value, failure } = useAtomValue(resultsAtoms[from]);
  const [view, setView] = useAtom(params.view);
  const [by, setBy] = useAtom(params.by);
  const [trend, setTrend] = useAtom(params.trend);
  const [dead, setDead] = useAtom(params.dead);
  const [y, setY] = useAtom(params.y);
  const [x, setX] = useAtom(params.x);
  const [color, setColor] = useAtom(params.color);
  const [facet, setFacet] = useAtom(params.facet);
  const [only, setOnly] = useAtom(params.run);
  const [pick, setPick] = useAtom(params.pick);
  const runs = useMemo(
    () => (value?.runs ?? []).filter(r => (!only || r.key === only) && (dead === '1' || !r.dead || only)),
    [value, only, dead]
  );
  const dimensions = useMemo(
    () => [...new Set(runs.flatMap(r => Object.keys(r.axes)))].filter(k => new Set(runs.map(r => r.axes[k])).size > 1),
    [runs]
  );
  if (!value) return failure ? <Muted>{failure}</Muted> : <Loading />;
  const measures = value.fields.filter(f => f.type !== 'string');
  const field = measures.find(f => key(f) === y) ?? measures.find(f => f.limit) ?? measures[0];
  const picked = value.runs.find(r => r.key === pick && r.step);
  const none = { value: '', label: 'none' };
  const colorBy = color === '' ? undefined : (color ?? dimensions.find(d => d === defaults[from].color));
  const dims = dimensions.map(d => ({ value: d, label: d }));
  const deadCount = value.runs.filter(r => r.dead).length;
  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <div className="min-w-0 flex-1 space-y-3 overflow-y-auto p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex gap-0.5 rounded-md bg-zinc-100 p-0.5 text-xs dark:bg-zinc-900">
            {['table', 'chart'].map(v => (
              <button
                key={v}
                type="button"
                aria-pressed={(view ?? 'table') === v}
                onClick={() => setView(v === 'table' ? null : v)}
                className="rounded px-2 py-0.5 aria-pressed:bg-white aria-pressed:shadow-sm dark:aria-pressed:bg-zinc-700"
              >
                {v}
              </button>
            ))}
          </span>
          {view === 'chart' ? (
            <>
              {field && (
                <Select
                  label="y"
                  value={key(field)}
                  options={measures.map(f => ({ value: key(f), label: key(f) }))}
                  onChange={setY}
                />
              )}
              <Select
                label="x"
                value={x ?? defaults[from].x}
                options={[
                  ...(from === 'tune' ? [{ value: 'iteration', label: 'iteration' }] : []),
                  { value: 'time', label: 'time' },
                  { value: 'order', label: 'order' },
                  ...dims.filter(d => d.value !== 'iteration'),
                  ...measures.map(f => ({ value: key(f), label: key(f) })),
                ]}
                onChange={setX}
              />
              <Select label="color" value={colorBy ?? ''} options={[none, ...dims]} onChange={v => setColor(v || '')} />
              <Select label="facet" value={facet ?? ''} options={[none, ...dims]} onChange={v => setFacet(v || null)} />
            </>
          ) : (
            <>
              <Select label="by" value={by ?? ''} options={[none, ...dims]} onChange={v => setBy(v || null)} />
              <Select
                label="trend over"
                value={trend ?? 'time'}
                options={[
                  { value: 'time', label: 'time, by day' },
                  { value: 'order', label: 'order, by tens' },
                  ...(from === 'tune' ? [{ value: 'iteration', label: 'iteration' }] : []),
                ]}
                onChange={v => setTrend(v === 'time' ? null : v)}
              />
            </>
          )}
          {deadCount > 0 && (
            <label className="flex items-center gap-1.5 text-xs text-zinc-500">
              <input type="checkbox" checked={dead === '1'} onChange={e => setDead(e.target.checked ? '1' : null)} />
              {deadCount} dead runs
            </label>
          )}
          {only && (
            <Button onClick={() => setOnly(null)}>
              only {only} <span aria-hidden>×</span>
            </Button>
          )}
        </div>
        {runs.length === 0 ? (
          <p className="text-xs text-zinc-500">No results here yet.</p>
        ) : view === 'chart' && field ? (
          <Suspense fallback={<Loading />}>
            <ResultChart
              runs={runs}
              fields={value.fields}
              encoding={{
                x: x ?? defaults[from].x,
                y: field,
                color: colorBy,
                facet: facet ?? undefined,
              }}
            />
          </Suspense>
        ) : (
          <ResultTable
            runs={runs}
            fields={value.fields}
            by={by ?? undefined}
            trend={trend ?? 'time'}
            onPick={f => {
              setY(key(f));
              setView('chart');
            }}
          />
        )}
      </div>
      {picked?.step && <Candidate tune={picked.axes.tune ?? ''} step={picked.step} onClose={() => setPick(null)} />}
    </div>
  );
};

export const ResultsPage = () => {
  const [picked, setPicked] = useAtom(params.from);
  const source = resultSources.find(s => s === picked) ?? 'runs';
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-zinc-200 px-4 py-2 text-xs dark:border-zinc-800">
        {resultSources.map(s => (
          <button
            key={s}
            type="button"
            aria-pressed={s === source}
            onClick={() => setPicked(s === 'runs' ? null : s)}
            className={cx(
              'rounded px-2 py-0.5',
              s === source ? 'bg-zinc-100 font-medium dark:bg-zinc-800' : 'text-zinc-500'
            )}
          >
            {s}
          </button>
        ))}
      </div>
      <Data key={source} from={source} />
    </div>
  );
};
