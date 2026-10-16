import { Controls, type Edge, MarkerType, type Node, ReactFlow, ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { atom, useAtom, useAtomValue } from 'jotai';
import { useEffect, useMemo, useState } from 'react';
import { type Graph, graphOf } from '../../../core/src/graph.ts';
import type { Trace } from '../../../core/src/store.ts';
import type { Run } from '../../../core/src/workflow.ts';
import { clock } from '../runs/bits.tsx';
import { useLiveStream } from '../runs/live.ts';
import { phaseWord } from '../runs/model.ts';
import { hubAtom, infoAtom, queryParam, selectedStepAtom } from '../state.ts';
import { Muted, Select, usePolling } from '../ui.tsx';
import { layout } from './layout.ts';
import { fixturesOf } from './model.ts';
import {
  BackEdge,
  type BackFlowEdge,
  Frame,
  type FrameFlowNode,
  Legend,
  Pill,
  type PillFlowNode,
  StepCard,
  type StepFlowNode,
} from './nodes.tsx';
import type { Fixture, Trail } from './scenarios.ts';
import { type StepState, stepStatesAtom } from './state.ts';
import { StepDetails, WorkflowDetails } from './StepDetails.tsx';
import { storyOf, trailOf, visitsOf } from './visits.ts';

/** Core's example workflows and the served core hub's, loaded on first use. */
const fixturesAtom = atom(async () => (await import('virtual:fixtures')).fixtures);
const hubParam = queryParam('hub');
const runParam = queryParam('run');
const served = 'served';

type Real = { fixture: string; run: Run; trace: Trace[] };
type Picked = { fixture: Fixture; run: Run; trail: Trail; trace?: Trace[] | undefined };

const nodeTypes = { step: StepCard, pill: Pill, frame: Frame };
const edgeTypes = { back: BackEdge };
const gray = '#a1a1aa';
const sky = '#0284c7';
const arrow = (color: string) => ({ type: MarkerType.ArrowClosed, color, width: 16, height: 16 });

/** A v1 step's latest live run, when it needs attention. */
const liveLine = (state: StepState | undefined, tries: number) => {
  if (!state || state.phase === 'done') return;
  if (state.phase === 'running') return `running${state.startedAt ? ` since ${clock(state.startedAt)}` : ''}`;
  if (state.phase === 'failed' && tries > 1)
    return `${phaseWord('failed', state.status)}, try ${state.tries} of ${tries}`;
  return phaseWord(state.phase, state.status);
};

/** Draws the workflows, each with its run overlay when it holds the picked run. */
const Canvas = ({ shown, picked }: { shown: Fixture[]; picked: Picked | undefined }) => {
  const [selected, select] = useAtom(selectedStepAtom);
  const { states } = useAtomValue(stepStatesAtom);
  const graphs = useMemo(
    () =>
      shown.map(f => {
        const run = picked?.fixture === f ? picked : undefined;
        const graph = graphOf(f.workflow, f.checks, run?.run);
        return { workflow: f.workflow.name, graph, run, visits: run && visitsOf(graph, run.trail, run.run).visits };
      }),
    [shown, picked]
  );
  const rows = useMemo(() => layout(graphs), [graphs]);
  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    graphs.forEach(({ workflow, graph, run, visits }, r) => {
      const row = rows[r]!;
      nodes.push({
        id: `${workflow}:frame`,
        type: 'frame',
        position: row.frame,
        data: {
          workflow,
          trigger: graph.trigger,
          worst: graph.worst,
          selected: selected === workflow,
          width: row.frame.width,
          height: row.frame.height,
        },
        selectable: false,
        zIndex: -1,
      } satisfies FrameFlowNode);
      const byStep = new Map(graph.nodes.map(n => [n.step, n]));
      const visited = (step: string) => !!byStep.get(step)?.run?.visited;
      for (const placed of row.nodes) {
        if (placed.kind !== 'step') {
          const done = placed.kind === 'done';
          nodes.push({
            id: placed.id,
            type: 'pill',
            position: placed.box,
            style: { width: placed.box.width, height: placed.box.height },
            data: {
              label: done ? 'done' : graph.trigger,
              done,
              reached: done ? run?.run.status === 'done' : !!run,
            },
            selectable: false,
          } satisfies PillFlowNode);
          continue;
        }
        const node = byStep.get(placed.step!)!;
        nodes.push({
          id: placed.id,
          type: 'step',
          position: placed.box,
          data: {
            node,
            selected: selected === placed.id,
            live: liveLine(states.get(placed.id), node.tries),
            ...(run && {
              overlay: {
                visits: visits!.filter(v => v.node.step === node.step).length,
                ...(node.run?.current &&
                  run.run.status !== 'done' && { status: run.run.status, reason: run.run.reason }),
              },
            }),
          },
        } satisfies StepFlowNode);
      }
      const chain = row.nodes.map(n => n.id);
      chain.slice(1).forEach((to, i) => {
        const from = chain[i]!;
        const fromStep = row.nodes[i]!.step;
        const toStep = row.nodes[i + 1]!.step;
        const taken =
          !!run &&
          (fromStep === undefined || visited(fromStep)) &&
          (toStep === undefined ? run.run.status === 'done' : visited(toStep));
        const color = taken ? sky : gray;
        edges.push({
          id: `${from}>${to}`,
          source: from,
          target: to,
          markerEnd: arrow(color),
          style: { stroke: color, strokeWidth: taken ? 2 : 1.25 },
        });
      });
      for (const edge of graph.edges.filter((e: Graph['edges'][number]) => e.kind === 'back'))
        edges.push({
          id: `${workflow}/back/${edge.from}`,
          type: 'back',
          source: `${workflow}/${edge.from}`,
          sourceHandle: 'out',
          target: `${workflow}/${edge.to}`,
          targetHandle: 'in',
          markerEnd: arrow((edge.taken ?? 0) > 0 ? sky : '#fb923c'),
          data: { edge },
        } satisfies BackFlowEdge);
    });
    return { nodes, edges };
  }, [graphs, rows, selected, states]);
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      fitView
      fitViewOptions={{ maxZoom: 1, padding: 0.08 }}
      minZoom={0.2}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, node) => node.type === 'step' && select(node.id === selected ? null : node.id)}
      onPaneClick={() => select(null)}
    >
      <Controls showInteractive={false} position="top-right" />
    </ReactFlow>
  );
};

/** The hubs the graph can show: the served v1 hub when it compiles, then every core hub the fixtures carry. */
const useHubs = () => {
  const hub = useAtomValue(hubAtom);
  const fixtures = useAtomValue(fixturesAtom);
  const info = useAtomValue(infoAtom);
  return useMemo(() => {
    const name = info?.hub.split('/').at(-1) ?? '';
    const groups = new Map<string, Fixture[]>();
    for (const f of fixtures) {
      const key = f.id.slice(0, f.id.indexOf('/'));
      groups.set(key, [...(groups.get(key) ?? []), f]);
    }
    const hubs = [...groups].map(([key, list]) => ({
      key,
      label: key === name ? `${key} (served)` : `${key} (example)`,
      fixtures: list,
    }));
    if ('config' in hub)
      return {
        name,
        hubs: [{ key: served, label: `${name} (served)`, fixtures: fixturesOf(hub.config) }, ...hubs],
        config: hub.config,
        errors: [],
      };
    return { name, hubs, errors: groups.has(name) ? [] : hub.errors };
  }, [hub, info, fixtures]);
};

/** Every workflow of a hub as one graph: the main path as arrows, ways back as arcs, the common moves as badges. */
export const GraphPage = () => {
  useLiveStream();
  const { name, hubs, config, errors } = useHubs();
  const [hubKey, setHub] = useAtom(hubParam);
  const [runKey, setRun] = useAtom(runParam);
  const selected = useAtomValue(selectedStepAtom);
  const [real, setReal] = useState<Real[]>([]);
  const poll = () =>
    fetch('/core/runs')
      .then(r => (r.ok ? r.json() : []))
      .then(setReal, () => {});
  useEffect(() => void poll(), []);
  usePolling(poll, 3000);

  const hub = hubs.find(h => h.key === hubKey) ?? hubs.find(h => h.key === served || h.key === name) ?? hubs[0];
  const runs = useMemo(
    () =>
      (hub?.fixtures ?? []).flatMap(fixture => [
        ...real
          .filter(r => r.fixture === fixture.id)
          .map(r => ({
            key: `${fixture.id}:${r.run.id}`,
            label: `${fixture.workflow.name}: ${r.run.id}`,
            fixture,
            run: r.run,
            trail: trailOf(r.run, r.trace),
            trace: r.trace,
          })),
        ...fixture.runs.map(s => ({
          key: `${fixture.id}:${s.label}`,
          label: `${fixture.workflow.name}: ${s.label} (simulated)`,
          fixture,
          run: s.run,
          trail: s.trail,
        })),
      ]),
    [hub, real]
  );
  const picked = runs.find(r => r.key === runKey);

  if (errors.length)
    return (
      <div className="space-y-2 p-4">
        <p className="font-medium">The hub does not compile.</p>
        <ul className="list-disc space-y-1 pl-5 text-xs">
          {errors.map((error, i) => (
            <li key={i}>
              <span className="font-mono">{error.path}</span>: {error.message}
            </li>
          ))}
        </ul>
      </div>
    );
  if (!hub || !hub.fixtures.length) return <Muted>This hub has no workflows.</Muted>;

  const [workflowName, stepName] = selected?.split('/') ?? [];
  const fixture = hub.fixtures.find(f => f.workflow.name === workflowName);
  const step = fixture?.workflow.steps.find(s => s.name === stepName);
  const story =
    picked &&
    storyOf(visitsOf(graphOf(picked.fixture.workflow, picked.fixture.checks, picked.run), picked.trail, picked.run));
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-4 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        {hubs.length > 1 && (
          <Select
            label="Hub"
            value={hub.key}
            options={hubs.map(h => ({ value: h.key, label: h.label }))}
            onChange={key => {
              setRun(null);
              setHub(key);
            }}
          />
        )}
        {runs.length > 0 && (
          <Select
            label="Run"
            value={picked?.key ?? ''}
            options={[
              { value: '', label: 'none, the workflow as written' },
              ...runs.map(r => ({ value: r.key, label: r.label })),
            ]}
            onChange={key => setRun(key || null)}
          />
        )}
        {story && <p className="min-w-0 flex-1 text-xs text-sky-700 dark:text-sky-300">{story}</p>}
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <ReactFlowProvider>
            <Canvas shown={hub.fixtures} picked={picked} />
          </ReactFlowProvider>
        </div>
        {fixture && (
          <aside className="w-80 shrink-0 overflow-y-auto border-l border-zinc-200 dark:border-zinc-800">
            {step ? (
              <StepDetails
                fixture={fixture}
                step={step}
                run={picked?.fixture === fixture ? picked : undefined}
                config={hub.key === served ? config : undefined}
              />
            ) : (
              <WorkflowDetails workflow={fixture.workflow} />
            )}
          </aside>
        )}
      </div>
      <Legend />
    </div>
  );
};
