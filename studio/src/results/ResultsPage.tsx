import { useAtom } from 'jotai';
import { Suspense, useMemo } from 'react';
import { queryParam } from '../state.ts';
import { usePluginData, ResultChart, ResultTable } from '../plugins.ts';
import { ResultsData } from './data.ts';
import { Button, Help, Live, Loading, Muted, Select } from '../ui.tsx';

const params = Object.fromEntries(
  ['view', 'by', 'trend', 'dead', 'y', 'x', 'color', 'facet', 'run'].map(k => [k, queryParam(k)])
) as Record<'view' | 'by' | 'trend' | 'dead' | 'y' | 'x' | 'color' | 'facet' | 'run', ReturnType<typeof queryParam>>;

const optionHints: Record<string, string> = {
  none: 'All runs together.',
  time: 'When the run happened.',
  order: 'Runs one after another, oldest first.',
  iteration: 'The tune iteration that proposed the variant.',
  issue: 'The issue the run worked on.',
  workflow: 'The workflow that ran.',
  status: 'How the run ended.',
  tune: 'The tune loop, as repo and name.',
  repo: 'The repo the case comes from.',
  variant: 'One graph a tune evaluates.',
  verdict: 'Whether the tune kept the variant.',
  proposer: 'What wrote the variant graph.',
  harness: 'The agent CLI that ran the model.',
  model: 'The model the agents used.',
  graph: 'The graph version that ran.',
};

const makeHintedOption = (value: string, label = value) => ({ value, label, title: optionHints[value || 'none'] });

const key = (f: { check: string; field: string }) => `${f.check} ${f.field}`;

const Sheet = ({ value }: { value: Extract<typeof ResultsData.Type, { kind: 'ready' }>['sheet'] }) => {
  const [view, setView] = useAtom(params.view);
  const [by, setBy] = useAtom(params.by);
  const [trend, setTrend] = useAtom(params.trend);
  const [dead, setDead] = useAtom(params.dead);
  const [y, setY] = useAtom(params.y);
  const [x, setX] = useAtom(params.x);
  const [color, setColor] = useAtom(params.color);
  const [facet, setFacet] = useAtom(params.facet);
  const [only, setOnly] = useAtom(params.run);
  const runs = useMemo(
    () => value.runs.filter(r => (!only || r.key === only) && (dead === '1' || !r.dead || only)),
    [value, only, dead]
  );
  const dimensions = useMemo(
    () => [...new Set(runs.flatMap(r => Object.keys(r.axes)))].filter(k => new Set(runs.map(r => r.axes[k])).size > 1),
    [runs]
  );
  const measures = value.fields.filter(f => f.type !== 'string');
  const field = measures.find(f => key(f) === y) ?? measures.find(f => f.limit) ?? measures[0];
  const none = makeHintedOption('', '-');
  const measureOptions = measures.map(f => ({ value: key(f), label: key(f), title: f.description }));
  const xAxis = x ?? 'time';
  const colorBy = color === '' ? undefined : (color ?? dimensions.find(d => d === 'workflow'));
  const dims = dimensions.map(d => makeHintedOption(d));
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
                className="cursor-pointer rounded px-2 py-0.5 hover:text-zinc-900 aria-pressed:bg-white aria-pressed:shadow-sm dark:aria-pressed:bg-zinc-700"
              >
                {v}
              </button>
            ))}
          </span>
          {view === 'chart' ? (
            <>
              {field && <Select label="y" value={key(field)} options={measureOptions} onChange={setY} />}
              <Select
                label="x"
                value={xAxis}
                options={[makeHintedOption('time'), makeHintedOption('order'), ...dims, ...measureOptions]}
                onChange={setX}
              />
              <Select
                label="color by"
                value={colorBy ?? ''}
                options={[none, ...dims]}
                onChange={v => setColor(v || '')}
              />
              <Select
                label="panels by"
                value={facet ?? ''}
                options={[none, ...dims]}
                onChange={v => setFacet(v || null)}
              />
              <Help tip="Draws one chart per value, stacked, so groups don't overlap." />
            </>
          ) : (
            <>
              <Select label="by" value={by ?? ''} options={[none, ...dims]} onChange={v => setBy(v || null)} />
              <Select
                label="trend over"
                value={trend ?? 'time'}
                options={[
                  makeHintedOption('time', 'time, by day'),
                  makeHintedOption('order', 'order, by tens'),
                  ...(dimensions.includes('iteration') ? [makeHintedOption('iteration')] : []),
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
        {runs.some(r => r.meta) && (
          <details className="text-xs">
            <summary className="cursor-pointer">Run metadata</summary>
            {runs
              .filter(r => r.meta)
              .map(r => (
                <details key={r.key} className="ml-3 py-1">
                  <summary className="cursor-pointer">{r.key}</summary>
                  {Object.entries(r.meta!).map(([owner, data]) => (
                    <div key={owner} className="p-2">
                      <strong>{owner}</strong>
                      <pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify(data, null, 2)}</pre>
                    </div>
                  ))}
                </details>
              ))}
          </details>
        )}
        {runs.length === 0 ? (
          <p className="text-xs text-zinc-500">No results here yet.</p>
        ) : view === 'chart' && field ? (
          <Suspense fallback={<Loading />}>
            <button
              type="button"
              className="cursor-pointer text-xs text-zinc-500 underline-offset-2 hover:text-zinc-900 hover:underline dark:hover:text-zinc-100"
              onClick={() => setView(null)}
            >
              &lt; table
            </button>
            <ResultChart
              runs={runs}
              fields={value.fields}
              encoding={{
                x: xAxis,
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
            onPick={(f, along) => {
              setY(key(f));
              if (along) setX(along);
              setView('chart');
            }}
          />
        )}
      </div>
    </div>
  );
};

const ResultsPage = () => (
  <div className="flex h-full min-h-0 flex-col">
    <Live state={usePluginData('results', ResultsData)}>
      {data => (data.kind === 'ready' ? <Sheet value={data.sheet} /> : <Muted>{data.why}</Muted>)}
    </Live>
  </div>
);

export default ResultsPage;
