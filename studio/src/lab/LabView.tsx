import { useAtomValue, useSetAtom } from 'jotai';
import { type ComponentType, lazy, Suspense, useMemo } from 'react';
import { hubAtom, locationAtom, navigateAtom } from '../state.ts';
import { cx, Muted } from '../ui.tsx';
import { type Chart, toChart } from './chart.ts';
import { type Caption, captions, type Lib, libs } from './captions.ts';
import { runMachine, workflowMachine } from './machines.ts';
import type { PanelProps } from './panel.ts';

const panels: Record<Lib, ComponentType<PanelProps>> = {
  elk: lazy(() => import('./panels/ElkFlow.tsx')),
  smcat: lazy(() => import('./panels/Smcat.tsx')),
  viz: lazy(() => import('./panels/Viz.tsx')),
  mermaid: lazy(() => import('./panels/Mermaid.tsx')),
  d2: lazy(() => import('./panels/D2.tsx')),
};

const charts = ['workflow', 'run'] as const;
type ChartName = (typeof charts)[number];

const selectedStyle = `
.lab-stage [data-state] { cursor: pointer; }
.lab-stage g.terminal > :is(path, polygon) { stroke-width: 3px; }
.lab-stage .lab-selected > :is(rect, path, polygon, ellipse, circle),
.lab-stage .lab-selected > g > :is(rect, path, polygon, ellipse, circle) { stroke: #0ea5e9 !important; stroke-width: 3px !important; }
`;

const Segmented = <T extends string>({
  options,
  value,
  label,
  onChange,
}: {
  options: readonly T[];
  value: T;
  label: (option: T) => string;
  onChange: (option: T) => void;
}) => (
  <div className="flex gap-0.5 rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-900">
    {options.map(option => (
      <button
        key={option}
        aria-current={option === value ? 'page' : undefined}
        onClick={() => onChange(option)}
        className={cx(
          'rounded-md px-2 py-0.5 text-xs',
          option === value
            ? 'bg-white font-medium shadow-sm dark:bg-zinc-700'
            : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
        )}
      >
        {label(option)}
      </button>
    ))}
  </div>
);

const CaptionCard = ({ caption }: { caption: Caption }) => (
  <dl className="space-y-2 text-xs">
    <div>
      <dt className="font-medium">{caption.name}</dt>
      <dd className="text-zinc-500">{caption.packages}</dd>
    </div>
    {(
      [
        ['size', caption.size],
        ['layout', caption.layout],
        ['interaction', caption.interaction],
        ['compound states and loops', caption.compound],
      ] as const
    ).map(([name, value]) => (
      <div key={name}>
        <dt className="text-[10px] uppercase tracking-wide text-zinc-400">{name}</dt>
        <dd className="text-zinc-700 dark:text-zinc-300">{value || 'not measured'}</dd>
      </div>
    ))}
  </dl>
);

const Transitions = ({ title, items }: { title: string; items: { id: string; text: string; label: string }[] }) =>
  items.length ? (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-zinc-400">{title}</div>
      <ul>
        {items.map(item => (
          <li key={item.id}>
            {item.text}
            {item.label && <span className="text-zinc-500">, {item.label}</span>}
          </li>
        ))}
      </ul>
    </div>
  ) : null;

const StateCard = ({ chart, id }: { chart: Chart; id: string }) => {
  const state = chart.states.get(id);
  if (!state) return null;
  const name = (sid: string) => chart.states.get(sid)?.label ?? sid;
  return (
    <div className="space-y-2 border-t border-zinc-200 pt-3 text-xs dark:border-zinc-800">
      <div>
        <span className="font-medium">{state.label}</span> <span className="text-zinc-400">{state.type}</span>
        <div className="font-mono text-[10px] text-zinc-400">{state.id}</div>
      </div>
      {state.notes.map(note => (
        <div key={note} className="text-zinc-600 dark:text-zinc-400">
          {note}
        </div>
      ))}
      <Transitions
        title="leaves"
        items={chart.edges
          .filter(e => e.from === id)
          .map(e => ({ id: e.id, text: `to ${name(e.to)}`, label: e.label }))}
      />
      <Transitions
        title="enters"
        items={chart.edges
          .filter(e => e.to === id)
          .map(e => ({ id: e.id, text: `from ${name(e.from)}`, label: e.label }))}
      />
    </div>
  );
};

const useCharts = (): Record<ChartName, Chart> | { error: string } => {
  const hub = useAtomValue(hubAtom);
  return useMemo(() => {
    if (!('config' in hub)) return { error: 'The hub config does not compile.' };
    const name = 'issue' in hub.config.workflows ? 'issue' : Object.keys(hub.config.workflows)[0];
    if (!name) return { error: 'The hub has no workflows.' };
    return { workflow: toChart(workflowMachine(hub.config, name)), run: toChart(runMachine) };
  }, [hub]);
};

export default function LabView() {
  const { query } = useAtomValue(locationAtom);
  const navigate = useSetAtom(navigateAtom);
  const lib = libs.find(l => l === query.get('lib')) ?? 'elk';
  const chartName = charts.find(c => c === query.get('chart')) ?? 'workflow';
  const selected = query.get('state') ?? undefined;
  const loaded = useCharts();
  if ('error' in loaded) return <Muted>{loaded.error}</Muted>;
  const chart = loaded[chartName];
  const Panel = panels[lib];
  const select = (id: string | undefined) => navigate({ query: { state: id ?? null }, replace: true });
  return (
    <div className="grid h-full grid-rows-[auto_1fr]">
      <style>{selectedStyle}</style>
      <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 px-3 py-1.5 dark:border-zinc-800">
        <span className="text-xs font-medium text-zinc-500">Statechart lab</span>
        <Segmented
          options={libs}
          value={lib}
          label={l => captions[l].name}
          onChange={l => navigate({ query: { lib: l } })}
        />
        <Segmented
          options={charts}
          value={chartName}
          label={c => (c === 'workflow' ? `workflow ${loaded.workflow.root.id}` : 'run lifecycle')}
          onChange={c => navigate({ query: { chart: c, state: null } })}
        />
      </div>
      <div className="flex min-h-0">
        <div className="relative min-w-0 flex-1">
          <Suspense fallback={<Muted>Loading {captions[lib].name}.</Muted>}>
            <Panel key={`${lib}:${chartName}`} chart={chart} selected={selected} onSelect={select} />
          </Suspense>
        </div>
        <aside className="w-80 shrink-0 space-y-3 overflow-y-auto border-l border-zinc-200 p-3 dark:border-zinc-800">
          <CaptionCard caption={captions[lib]} />
          {selected ? (
            <StateCard chart={chart} id={selected} />
          ) : (
            <p className="border-t border-zinc-200 pt-3 text-xs text-zinc-500 dark:border-zinc-800">
              Click a state to see its transitions.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
