import { Controls, type Edge, MarkerType, type Node, ReactFlow, ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useAtom, useAtomValue } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import { useMemo } from 'react';
import { fixtures, served } from 'virtual:fixtures';
import { makeWorkflowGraph } from '../../../src/graph.ts';
import { queryParam, runsAtom, selectedStepAtom } from '../state.ts';
import { Problems } from '../Problems.tsx';
import { accent, AutoHeight, Combobox, Muted, Select } from '../ui.tsx';
import { layout, type Start } from './layout.ts';
import {
  Frame,
  type FrameFlowNode,
  Legend,
  Pill,
  type PillFlowNode,
  RouteEdge,
  type RouteFlowEdge,
  StepCard,
  type StepFlowNode,
} from './nodes.tsx';
import type { Fixture, RunDrawnOnWorkflow } from './scenarios.ts';
import { AgentDetails, CheckDetails } from './OpenedDetails.tsx';
import { StepDetails, WorkflowDetails } from './StepDetails.tsx';
import { splitSelection } from './trail.ts';
import { makeRunStory, makeRunTrail, makeWorkflowRunVisits } from './visits.ts';

const hubParam = queryParam('hub');
const runParam = queryParam('run');
const hideParam = queryParam('hide');

const panelAtom = atomWithStorage('agentgraph.stepPanel', 320, undefined, { getOnInit: true });
const panelWidth = (w: number) => Math.round(Math.min(Math.max(w, 260), 720, innerWidth * 0.7));

/** The side panel's width, dragged from its left edge and kept across visits. */
const usePanelWidth = () => {
  const [stored, setStored] = useAtom(panelAtom);
  const width = panelWidth(stored);
  const resize = (down: React.PointerEvent) => {
    down.preventDefault();
    const move = (e: PointerEvent) => setStored(panelWidth(width + down.clientX - e.clientX));
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };
  return [width, resize] as const;
};

/**
 * The workflows of `shown` as one canvas, with the selected run drawn over its workflow, and a side panel for the
 * selected step or workflow.
 */
const WorkflowGraph = ({
  shown,
  picked,
  hidden,
}: {
  shown: Fixture[];
  picked: RunDrawnOnWorkflow | undefined;
  hidden: ReadonlySet<string>;
}) => {
  const selected = useAtomValue(selectedStepAtom);
  const { workflow: workflowName, step: stepName, trail } = splitSelection(selected);
  const fixture = shown.find(f => f.workflow.name === workflowName);
  const step = fixture?.workflow.steps.find(s => s.name === stepName);
  const opened = step && trail.at(-1);
  const path = step && [workflowName, stepName, ...trail.map(t => `${t.kind}:${t.name}`)].join('/');
  const [width, resize] = usePanelWidth();
  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <div className="min-h-0 min-w-0 flex-1">
        <ReactFlowProvider>
          <Canvas shown={shown} picked={picked} hidden={hidden} />
        </ReactFlowProvider>
      </div>
      {fixture && (
        <aside
          style={{ '--panel': `${width}px` } as React.CSSProperties}
          className="relative flex max-h-[45%] shrink-0 flex-col border-t border-zinc-200 md:max-h-none md:w-(--panel) md:border-t-0 md:border-l dark:border-zinc-800"
        >
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the panel"
            onPointerDown={resize}
            className="absolute inset-y-0 -left-1 z-10 hidden w-2 cursor-col-resize transition-colors hover:bg-zinc-300/60 md:block dark:hover:bg-zinc-700/60"
          />
          <div key={path} className="agi-in min-h-0 flex-1 overflow-y-auto">
            {opened?.kind === 'check' ? (
              <CheckDetails fixture={fixture} path={path!} name={opened.name} />
            ) : opened?.kind === 'agent' ? (
              <AgentDetails fixture={fixture} hub={shown} path={path!} name={opened.name} />
            ) : step ? (
              <StepDetails fixture={fixture} step={step} run={picked?.fixture === fixture ? picked : undefined} />
            ) : (
              <WorkflowDetails workflow={fixture.workflow} />
            )}
          </div>
        </aside>
      )}
    </div>
  );
};

const nodeTypes = { step: StepCard, pill: Pill, frame: Frame };
const edgeTypes = { route: RouteEdge };
const gray = '#a1a1aa';
const sky = '#0284c7';
/** An edge's arrow and stroke; dashed off the main path. */
const line = (color: string, { width = 1.25, dashed = false } = {}) => ({
  markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
  style: { stroke: color, strokeWidth: width, ...(dashed && { strokeDasharray: '5 4' }) },
});
/** A node placed at `box` with that size. */
const placed = (box: { x: number; y: number; width: number; height: number }) => ({
  position: box,
  measured: { width: box.width, height: box.height },
  style: { width: box.width, height: box.height },
});

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

/** Draws the workflows, each with its run overlay when it holds the selected run. */
const Canvas = ({
  shown,
  picked,
  hidden,
}: {
  shown: Fixture[];
  picked: RunDrawnOnWorkflow | undefined;
  hidden: ReadonlySet<string>;
}) => {
  const [selected, select] = useAtom(selectedStepAtom);
  const here = useHere();
  const graphs = useMemo(
    () =>
      shown.map(f => {
        const run = picked?.fixture === f ? picked : undefined;
        const graph = makeWorkflowGraph(f.workflow, f.checks, run?.run, f.roles);
        return {
          fixture: f.id,
          workflow: f.workflow.name,
          dispatched: f.workflow.on.dispatch !== undefined,
          heard: f.workflow.on.feedback !== undefined,
          graph,
          run,
          visits: run && makeWorkflowRunVisits(graph, run.trail, run.run).visits,
        };
      }),
    [shown, picked]
  );
  const laid = useMemo(() => {
    const dispatched = graphs.filter(g => g.dispatched);
    const starts: Start[] = graphs.flatMap(({ workflow, graph }) => {
      const heard = graphs.filter(g => g.heard && g.workflow !== workflow);
      const asked = graph.nodes.filter(n => n.doer === 'human');
      return [
        ...graph.nodes.filter(n => n.dispatches).flatMap(n => dispatched.map(t => ({ node: n, target: t }))),
        ...(asked.length > 0 ? asked : graph.nodes.slice(-1)).flatMap(n => heard.map(t => ({ node: n, target: t }))),
      ].map(({ node, target }) => ({ workflow, step: node.step, target: target.workflow }));
    });
    return layout(graphs, starts, hidden);
  }, [graphs, hidden]);
  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    graphs.forEach(({ fixture, workflow, graph, run, visits }, r) => {
      const row = laid.rows[r]!;
      nodes.push({
        id: `${workflow}:frame`,
        type: 'frame',
        ...placed(row.frame),
        data: { workflow, trigger: graph.trigger, worst: graph.worst, selected: selected === workflow },
        selectable: false,
        zIndex: -1,
      } satisfies FrameFlowNode);
      const byStep = new Map(graph.nodes.map(n => [n.step, n]));
      const visited = (step: string) => !!byStep.get(step)?.run?.visited;
      for (const { id, kind, step, box } of row.nodes) {
        if (kind !== 'step') {
          const done = kind === 'done';
          nodes.push({
            id,
            type: 'pill',
            ...placed(box),
            data: {
              label: done ? 'done' : graph.trigger,
              done,
              reached: done ? run?.run.status === 'done' : !!run,
            },
            selectable: false,
          } satisfies PillFlowNode);
          continue;
        }
        const node = byStep.get(step!)!;
        nodes.push({
          id,
          type: 'step',
          ...placed(box),
          data: {
            node,
            selected: selected === id || !!selected?.startsWith(`${id}/`),
            hidden,
            live: picked ? undefined : here.get(`${fixture}/${node.step}`),
            ...(run && {
              overlay: {
                visits: visits!.filter(v => v.node.step === node.step).length,
                ...(node.run?.current && run.run.status !== 'done' && { here: run.run }),
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
        edges.push({
          id: `${from}>${to}`,
          source: from,
          target: to,
          type: 'straight',
          ...(taken ? line(sky, { width: 2 }) : line(gray)),
        });
      });
      for (const { edge, points } of row.backs)
        edges.push({
          id: `${workflow}/back/${edge.from}`,
          type: 'route',
          source: `${workflow}/${edge.from}`,
          target: `${workflow}/${edge.to}`,
          ...line((edge.taken ?? 0) > 0 ? sky : gray, { dashed: true }),
          data: { points, back: edge },
        } satisfies RouteFlowEdge);
    });
    for (const start of laid.starts)
      edges.push({
        id: `${start.workflow}/${start.step}>${start.target}`,
        type: 'route',
        source: `${start.workflow}/${start.step}`,
        target: `${start.target}:trigger`,
        ...line(gray, { dashed: true }),
        data: { points: start.points, tip: `${start.step} starts a ${start.target} run.` },
      } satisfies RouteFlowEdge);
    return { nodes, edges };
  }, [graphs, laid, selected, here, hidden]);
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
  const [hide, setHide] = useAtom(hideParam);
  const hidden = useMemo(() => new Set(hide?.split(',')), [hide]);

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
            trail: makeRunTrail(r.run, r.trace),
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
      <Problems />
      <AutoHeight className="flex flex-wrap items-center gap-4 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
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
              {makeRunStory(
                makeWorkflowRunVisits(
                  makeWorkflowGraph(picked.fixture.workflow, picked.fixture.checks, picked.run, picked.fixture.roles),
                  picked.trail,
                  picked.run
                )
              )}
            </>
          ) : hub.key === served?.name ? (
            'The workflows as written. A blue step holds runs that are live now.'
          ) : (
            'The workflows as written. An example hub, with no runs of its own.'
          )}
        </p>
      </AutoHeight>
      <WorkflowGraph shown={hub.fixtures} picked={picked} hidden={hidden} />
      <Legend
        hidden={hidden}
        onToggle={kind =>
          setHide(
            [...hidden]
              .filter(k => k !== kind)
              .concat(hidden.has(kind) ? [] : [kind])
              .join(',') || null
          )
        }
      />
    </div>
  );
};
