import { Controls, type Edge, MarkerType, type Node, ReactFlow, ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useAtom, useAtomValue } from 'jotai';
import { useMemo } from 'react';
import { fixtures, served } from 'virtual:fixtures';
import { type Graph, graphOf } from '../../../src/graph.ts';
import type { Trace } from '../../../src/store.ts';
import type { Run } from '../../../src/workflow.ts';
import { queryParam, runsAtom, selectedStepAtom } from '../state.ts';
import { accent, Combobox, Muted, Select } from '../ui.tsx';
import { layout } from './layout.ts';
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
import { StepDetails, WorkflowDetails } from './StepDetails.tsx';
import { storyOf, trailOf, visitsOf } from './visits.ts';

const hubParam = queryParam('hub');
const runParam = queryParam('run');

/** A run drawn over its workflow: a real one carries its trace, a simulated one only its trail. */
type Picked = { fixture: Fixture; run: Run; trail: Trail; trace?: Trace[] | undefined };

/** The picked run told in one sentence. */
export const storyOfRun = (p: Picked) =>
  storyOf(visitsOf(graphOf(p.fixture.workflow, p.fixture.checks, p.run, p.fixture.returns), p.trail, p.run));

/**
 * The workflows of `shown` as one canvas, with the picked run drawn over its workflow, and a side panel for the
 * selected step or workflow.
 */
export const WorkflowGraph = ({ shown, picked }: { shown: Fixture[]; picked: Picked | undefined }) => {
  const selected = useAtomValue(selectedStepAtom);
  const [workflowName, stepName] = selected?.split('/') ?? [];
  const fixture = shown.find(f => f.workflow.name === workflowName);
  const step = fixture?.workflow.steps.find(s => s.name === stepName);
  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <div className="min-h-0 min-w-0 flex-1">
        <ReactFlowProvider>
          <Canvas shown={shown} picked={picked} />
        </ReactFlowProvider>
      </div>
      {fixture && (
        <aside className="max-h-[45%] shrink-0 overflow-y-auto border-t border-zinc-200 md:max-h-none md:w-80 md:border-t-0 md:border-l dark:border-zinc-800">
          {step ? (
            <StepDetails fixture={fixture} step={step} run={picked?.fixture === fixture ? picked : undefined} />
          ) : (
            <WorkflowDetails workflow={fixture.workflow} />
          )}
        </aside>
      )}
    </div>
  );
};

const nodeTypes = { step: StepCard, pill: Pill, frame: Frame };
const edgeTypes = { back: BackEdge };
const gray = '#a1a1aa';
const sky = '#0284c7';
const arrow = (color: string) => ({ type: MarkerType.ArrowClosed, color, width: 16, height: 16 });

/** How many of the served hub's runs stand at each step and are not done, keyed `fixture/step`. */
const useHere = () => {
  const { value: runs = [] } = useAtomValue(runsAtom);
  return useMemo(() => {
    const here = new Map<string, Record<string, number>>();
    for (const { fixture, run } of runs) {
      if (run.status !== 'running' && run.status !== 'waiting') continue;
      const key = `${fixture}/${run.step}`;
      const counts = here.get(key) ?? {};
      counts[run.status] = (counts[run.status] ?? 0) + 1;
      here.set(key, counts);
    }
    return here;
  }, [runs]);
};

const hereLine = (counts: Record<string, number> | undefined) =>
  counts &&
  Object.entries(counts)
    .map(([status, n]) => `${n} ${status}`)
    .join(', ');

/** Draws the workflows, each with its run overlay when it holds the picked run. */
const Canvas = ({ shown, picked }: { shown: Fixture[]; picked: Picked | undefined }) => {
  const [selected, select] = useAtom(selectedStepAtom);
  const here = useHere();
  const graphs = useMemo(
    () =>
      shown.map(f => {
        const run = picked?.fixture === f ? picked : undefined;
        const graph = graphOf(f.workflow, f.checks, run?.run, f.returns);
        return {
          fixture: f.id,
          workflow: f.workflow.name,
          dispatched: f.workflow.on.dispatch !== undefined,
          graph,
          run,
          visits: run && visitsOf(graph, run.trail, run.run).visits,
        };
      }),
    [shown, picked]
  );
  const rows = useMemo(() => layout(graphs), [graphs]);
  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    graphs.forEach(({ fixture, workflow, graph, run, visits }, r) => {
      const row = rows[r]!;
      nodes.push({
        id: `${workflow}:frame`,
        type: 'frame',
        position: row.frame,
        measured: { width: row.frame.width, height: row.frame.height },
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
            measured: { width: placed.box.width, height: placed.box.height },
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
          measured: { width: placed.box.width, height: placed.box.height },
          data: {
            node,
            selected: selected === placed.id,
            live: run ? undefined : hereLine(here.get(`${fixture}/${node.step}`)),
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
          markerEnd: arrow((edge.taken ?? 0) > 0 ? sky : gray),
          data: { edge },
        } satisfies BackFlowEdge);
      const dispatched = graphs.filter(g => g.dispatched);
      for (const node of graph.nodes.filter(n => n.dispatches))
        for (const target of dispatched)
          edges.push({
            id: `${workflow}/${node.step}>${target.workflow}`,
            source: `${workflow}/${node.step}`,
            target: `${target.workflow}:trigger`,
            markerEnd: arrow(gray),
            style: { stroke: gray, strokeWidth: 1.25, strokeDasharray: '2 4' },
          });
    });
    return { nodes, edges };
  }, [graphs, rows, selected, here]);
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

/** The hubs the graph can show: the live hub first, then every example hub the fixtures carry. */
const hubs = (() => {
  const groups = new Map<string, Fixture[]>();
  for (const f of fixtures) {
    const key = f.id.slice(0, f.id.indexOf('/'));
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  return [...groups].map(([key, list]) => ({
    key,
    label: key === served?.name ? `${key}, live` : `${key}, example`,
    fixtures: list,
  }));
})();

/** Every workflow of a hub as one graph: the main path as arrows, ways back as arcs, the common moves as badges. */
export const GraphPage = () => {
  const [hubKey, setHub] = useAtom(hubParam);
  const [runKey, setRun] = useAtom(runParam);
  const { value: real = [] } = useAtomValue(runsAtom);

  const hub = hubs.find(h => h.key === hubKey) ?? hubs[0];
  const runs = useMemo(
    () =>
      (hub?.fixtures ?? []).flatMap(fixture => [
        ...real
          .filter(r => r.fixture === fixture.id)
          .map(r => ({
            key: `${fixture.id}:${r.run.id}`,
            label: `#${r.run.issue} ${fixture.workflow.name}, ${r.run.status} at ${r.run.step}, ${r.run.id}`,
            fixture,
            run: r.run,
            trail: trailOf(r.run, r.trace),
            trace: r.trace,
          })),
        ...fixture.runs.map(s => ({
          key: `${fixture.id}:${s.label}`,
          label: `simulated ${fixture.workflow.name}, ${s.label}`,
          fixture,
          run: s.run,
          trail: s.trail,
        })),
      ]),
    [hub, real]
  );
  const picked = runs.find(r => r.key === runKey);

  if (!hub || !hub.fixtures.length) return <Muted>This hub has no workflows.</Muted>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {served && served.problems.length > 0 && (
        <ul className="list-disc space-y-1 border-b border-zinc-200 py-2 pr-4 pl-8 text-xs dark:border-zinc-800">
          {served.problems.map((problem, i) => (
            <li key={i}>
              {served?.name} does not load: <span className="font-mono">{problem.path}</span>, {problem.message}
            </li>
          ))}
        </ul>
      )}
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
          <Combobox
            label="Run"
            placeholder="none, the workflows as written"
            value={picked?.key ?? null}
            options={runs.map(r => ({ value: r.key, label: r.label }))}
            onChange={setRun}
          />
        )}
        <p className="w-full min-w-0 text-xs text-zinc-500 sm:w-auto sm:flex-1">
          {picked ? (
            <>
              <span className={accent.text}>
                {'trace' in picked ? `Live, run ${picked.run.id}` : 'Simulated run'}, {picked.run.status} at{' '}
                {picked.run.step}.
              </span>{' '}
              {storyOfRun(picked)}
            </>
          ) : hub.key === served?.name ? (
            'The workflows as written. A blue step holds runs that are live now.'
          ) : (
            'The workflows as written. An example hub, with no runs of its own.'
          )}
        </p>
      </div>
      <WorkflowGraph shown={hub.fixtures} picked={picked} />
      <Legend />
    </div>
  );
};
