import {
  Background,
  ControlButton,
  Controls,
  type Edge,
  type NodeChange,
  Panel,
  ReactFlow,
  useNodesInitialized,
  useReactFlow,
  useStoreApi,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type GraphEdge, type GraphModel, type Layer, layerModel, retryLoops } from '../graph-model.ts';
import { cx } from '../ui.tsx';
import { type Box, castSize, checkGroups, edgeId, frame, layout, loopRoom, nodeSize, type Point } from './layout.ts';
import { type LoopFlowEdge, LoopEdge, type RoutedFlowEdge, RoutedEdge } from './LoopEdge.tsx';
import {
  CastCard,
  type FlowNode,
  type FrameFlowNode,
  JobCard,
  type JobFlowNode,
  NodeCard,
  SelectNode,
  WorkflowFrame,
} from './NodeCard.tsx';
import { applyMoves, decorate, loadPositions, placeNodes, savePositions } from './placed.ts';
import { defaultEdgeLabel, edgeStyle } from './styles.ts';

const nodeTypes = { graph: NodeCard, job: JobCard, cast: CastCard, workflow: WorkflowFrame };
const edgeTypes = { routed: RoutedEdge, loop: LoopEdge };
const fitViewOptions = { padding: 0.06 };

const label = (edge: GraphEdge) => edge.label ?? defaultEdgeLabel[edge.kind];

const strokeOf = (edge: GraphEdge) => String(edgeStyle[edge.kind].style?.stroke ?? '#71717a');

type FlowEdge = RoutedFlowEdge | LoopFlowEdge;
type AnyNode = FlowNode | JobFlowNode;

type Frame = { data: FrameFlowNode['data']; members: string[]; looped: Set<string> };

/** The workflow each trigger, job and script belongs to, and each check through the first job it gates. */
const workflowOf = (model: GraphModel) => {
  const byId = new Map(model.nodes.map(n => [n.id, n]));
  const own = (id: string) => {
    const workflow = byId.get(id)?.data?.workflow;
    return typeof workflow === 'string' ? workflow : undefined;
  };
  return (id: string) =>
    byId.get(id)?.kind === 'check'
      ? model.edges
          .filter(e => e.kind === 'gates' && e.from === id)
          .map(e => own(e.to))
          .find(Boolean)
      : own(id);
};

const toFlow = (full: GraphModel, layer: Layer) => {
  const shown = layerModel(full, layer);
  const model = retryLoops(shown);
  const groups = checkGroups(shown);
  const { boxes, routes, main: spine, clusters } = layout(model, label, groups, workflowOf(full));
  const main = (id: string) => spine.has(id);
  const byId = new Map(full.nodes.map(n => [n.id, n]));
  const looped = new Set(
    model.edges.filter(e => e.from === e.to).flatMap(e => [e.from, ...(groups.get(e.from) ?? [])])
  );
  const frames = [...clusters].map(([name, members]): Frame => ({
    data: { name, path: members.map(id => byId.get(id)?.source?.path).find(Boolean) },
    members,
    looped: new Set(members.filter(id => looped.has(id))),
  }));
  const castOf = (id: string, kind: GraphEdge['kind'][]) => {
    const to = full.edges.find(e => e.from === id && kind.includes(e.kind))?.to;
    return to ? byId.get(to) : undefined;
  };
  const nodes = model.nodes.map((node): AnyNode => {
    const box = boxes.get(node.id);
    const position = box ? { x: box.x, y: box.y } : { x: 0, y: 0 };
    if (node.kind === 'job')
      return {
        id: node.id,
        type: 'job',
        position,
        data: { node, bot: castOf(node.id, ['runs-as', 'fans-out']), skill: castOf(node.id, ['uses-skill']) },
      };
    return {
      id: node.id,
      type: node.kind === 'bot' || node.kind === 'skill' ? 'cast' : 'graph',
      position,
      data: { node },
    };
  });
  const edges: FlowEdge[] = model.edges.map((edge): FlowEdge => {
    const { style, markerEnd } = edgeStyle[edge.kind];
    const text = label(edge);
    const faint = !main(edge.from) && !main(edge.to);
    const gate = edge.kind === 'gates' && !!groups.get(edge.to)?.includes(edge.from);
    const color = strokeOf(edge);
    const common = {
      id: edgeId(edge),
      source: gate ? edge.to : edge.from,
      target: gate ? edge.from : edge.to,
      focusable: false,
      ...(style && {
        style: { ...style, ...(edge.kind === 'fans-out' && { strokeWidth: 2 }), ...(faint && { opacity: 0.45 }) },
      }),
      ...(markerEnd && { markerEnd }),
    } satisfies Partial<Edge>;
    if (edge.from === edge.to)
      return {
        ...common,
        type: 'loop',
        data: { checks: groups.get(edge.from) ?? [], color, ...(text && { label: text }) },
      };
    const route = routes.get(edgeId(edge));
    const [from, to] = [boxes.get(edge.from), boxes.get(edge.to)];
    const via = groups.get(edge.from);
    return {
      ...common,
      type: 'routed',
      data: {
        color,
        ...(text && { label: text }),
        ...(faint && { quiet: true }),
        ...(via && main(edge.to) && !via.includes(edge.to) && { via }),
        ...(route &&
          from &&
          to && { points: route.points, at: [from, to], ...(route.label && { labelAt: route.label }) }),
      },
    };
  });
  return { nodes, edges, frames };
};

const sizeOf = (node: AnyNode) =>
  node.measured?.width && node.measured.height
    ? { width: node.measured.width, height: node.measured.height }
    : node.type === 'cast'
      ? castSize
      : nodeSize;

/** The frame around a workflow's members where they are now, or nothing when none is placed. */
const frameBox = ({ members, looped }: Frame, at: Map<string, AnyNode>): Box | undefined => {
  const boxes = members.flatMap(id => {
    const node = at.get(id);
    if (!node) return [];
    const { width, height } = sizeOf(node);
    return [{ ...node.position, width, height: height + (looped.has(id) ? loopRoom : 0) }];
  });
  if (!boxes.length) return;
  const x = Math.min(...boxes.map(b => b.x)) - frame.pad;
  const y = Math.min(...boxes.map(b => b.y)) - frame.pad - frame.title;
  return {
    x,
    y,
    width: Math.max(...boxes.map(b => b.x + b.width)) + frame.pad - x,
    height: Math.max(...boxes.map(b => b.y + b.height)) + frame.pad - y,
  };
};

const frameStyle = { pointerEvents: 'none' } as const;

/** A frame node per workflow following its members as they move, the same object while its box stays put. */
const useFrames = (frames: Frame[], nodes: AnyNode[]) => {
  const last = useRef(new Map<string, FrameFlowNode>());
  return useMemo(() => {
    const at = new Map(nodes.map(n => [n.id, n]));
    const next = frames.flatMap((f): FrameFlowNode[] => {
      const box = frameBox(f, at);
      if (!box) return [];
      const id = `frame:${f.data.name}`;
      const prev = last.current.get(id);
      if (
        prev?.data === f.data &&
        prev.position.x === box.x &&
        prev.position.y === box.y &&
        prev.width === box.width &&
        prev.height === box.height
      )
        return [prev];
      const { x, y, width, height } = box;
      return [
        {
          id,
          type: 'workflow',
          position: { x, y },
          width,
          height,
          measured: { width, height },
          data: f.data,
          draggable: false,
          selectable: false,
          focusable: false,
          zIndex: -1,
          style: frameStyle,
        },
      ];
    });
    last.current = new Map(next.map(n => [n.id, n]));
    return next;
  }, [frames, nodes]);
};

const isFrameChange = (change: NodeChange) => 'id' in change && change.id.startsWith('frame:');

const storageKey = (graph: string) => `bhm:graph-layout:${import.meta.env.VITE_BHM_HUB ?? 'hub'}:${graph}`;
const layerKey = 'bhm.studio.layer';

const loadLayer = (): Layer => {
  try {
    return localStorage.getItem(layerKey) === 'cast' ? 'cast' : 'flow';
  } catch {
    return 'flow';
  }
};

const useLayer = () => {
  const [layer, setLayer] = useState(loadLayer);
  const choose = useCallback((next: Layer) => {
    setLayer(next);
    try {
      localStorage.setItem(layerKey, next);
    } catch {}
  }, []);
  return [layer, choose] as const;
};

/**
 * The nodes React Flow draws, owned here so drags and measurements apply in place. They are placed again only when
 * the layout or its storage key changes; dragged positions are saved when a drag stops.
 */
const usePlaced = (laidOut: AnyNode[], key: string, selected: string | null, near: Set<string> | undefined) => {
  const [state, setState] = useState(() => {
    const saved = loadPositions(key);
    return { laidOut, key, selected, near, saved, nodes: decorate(placeNodes(laidOut, saved), selected, near) };
  });
  let current = state;
  if (state.laidOut !== laidOut || state.key !== key) {
    const saved = loadPositions(key);
    const ids = new Set(laidOut.map(n => n.id));
    const kept = Object.fromEntries(Object.entries(saved).filter(([id]) => ids.has(id)));
    current = {
      laidOut,
      key,
      selected,
      near,
      saved: kept,
      nodes: decorate(placeNodes(laidOut, kept, state.nodes), selected, near),
    };
    setState(current);
  } else if (state.selected !== selected || state.near !== near) {
    current = { ...state, selected, near, nodes: decorate(state.nodes, selected, near) };
    setState(current);
  }
  const onNodesChange = useCallback(
    (changes: NodeChange<AnyNode>[]) => setState(s => ({ ...s, nodes: applyMoves(changes, s.nodes) })),
    []
  );
  const onNodeDragStop = useCallback(
    (_: unknown, __: unknown, dropped: { id: string; position: Point }[]) =>
      setState(s => {
        const saved: Record<string, Point> = {
          ...s.saved,
          ...Object.fromEntries(dropped.map(n => [n.id, n.position])),
        };
        savePositions(s.key, saved);
        return { ...s, saved };
      }),
    []
  );
  const reset = useCallback(
    () =>
      setState(s => {
        savePositions(s.key, {});
        return { ...s, saved: {}, nodes: decorate(placeNodes(s.laidOut, {}, s.nodes), s.selected, s.near) };
      }),
    []
  );
  return { nodes: current.nodes, moved: Object.keys(current.saved).length > 0, onNodesChange, onNodeDragStop, reset };
};

const ResetIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden>
    <path
      d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const GraphControls = ({ moved, onReset }: { moved: boolean; onReset: () => void }) => {
  const flow = useReactFlow();
  return (
    <Controls showInteractive={false}>
      <ControlButton
        title="Reset layout"
        aria-label="Reset layout"
        disabled={!moved}
        onClick={() => {
          onReset();
          requestAnimationFrame(() => void flow.fitView({ ...fitViewOptions, duration: 300 }));
        }}
      >
        <ResetIcon />
      </ControlButton>
    </Controls>
  );
};

const toggle =
  'rounded px-2 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100 aria-pressed:bg-zinc-200 aria-pressed:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:aria-pressed:bg-zinc-700 dark:aria-pressed:text-zinc-100';

/** The layers the canvas draws: the flow always, bots and skills on demand. */
const Layers = ({ layer, onChange }: { layer: Layer; onChange: (layer: Layer) => void }) => {
  const flow = useReactFlow();
  return (
    <Panel
      position="top-left"
      className="flex items-center gap-1 rounded-md border border-zinc-200 bg-white p-1 shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
    >
      <span className="px-1 text-[10px] uppercase tracking-wide text-zinc-500">layers</span>
      <button type="button" className={cx(toggle, 'cursor-default')} aria-pressed title="The flow is always shown">
        Flow
      </button>
      <button
        type="button"
        className={toggle}
        aria-pressed={layer === 'cast'}
        title="Show the bot and skill each step casts"
        onClick={() => {
          onChange(layer === 'cast' ? 'flow' : 'cast');
          requestAnimationFrame(() => void flow.fitView({ ...fitViewOptions, duration: 300 }));
        }}
      >
        Bots and skills
      </button>
    </Panel>
  );
};

const margin = 24;

/** Pans the selected node into view when it is outside the visible part of the canvas. */
const FocusSelected = ({ id }: { id: string | null }) => {
  const flow = useReactFlow();
  const store = useStoreApi();
  const ready = useNodesInitialized();
  useEffect(() => {
    const node = id && ready ? flow.getInternalNode(id) : undefined;
    if (!node) return;
    const { width, height } = store.getState();
    const { x, y, zoom } = flow.getViewport();
    const { x: nx, y: ny } = node.internals.positionAbsolute;
    const w = node.measured.width ?? nodeSize.width;
    const h = node.measured.height ?? nodeSize.height;
    const [left, top] = [nx * zoom + x, ny * zoom + y];
    const inside =
      left >= margin && top >= margin && left + w * zoom <= width - margin && top + h * zoom <= height - margin;
    if (!inside) void flow.setCenter(nx + w / 2, ny + h / 2, { zoom: Math.max(zoom, 0.7), duration: 400 });
  }, [id, ready, flow, store]);
  return null;
};

/** The hub graph by layer, draggable; `layoutKey` names the graph whose dragged positions are remembered. */
export const GraphCanvas = ({
  model,
  selected,
  onSelect,
  layoutKey,
}: {
  model: GraphModel;
  selected: string | null;
  onSelect: (id: string | null) => void;
  layoutKey: string;
}) => {
  const [layer, setLayer] = useLayer();
  const flow = useMemo(() => toFlow(model, layer), [model, layer]);
  const near = useMemo(() => {
    if (!selected) return undefined;
    const ids = new Set([selected]);
    for (const e of flow.edges) if (e.source === selected || e.target === selected) ids.add(e.source).add(e.target);
    return ids;
  }, [flow, selected]);
  const placed = usePlaced(flow.nodes, storageKey(`${layoutKey}:${layer}`), selected, near);
  const frames = useFrames(flow.frames, placed.nodes);
  const nodes = useMemo(() => [...frames, ...placed.nodes], [frames, placed.nodes]);
  const { onNodesChange: moveNodes } = placed;
  const onNodesChange = useCallback(
    (changes: NodeChange<AnyNode | FrameFlowNode>[]) =>
      moveNodes(changes.filter((c): c is NodeChange<AnyNode> => !isFrameChange(c))),
    [moveNodes]
  );
  const edges = useMemo(
    () =>
      near
        ? flow.edges.map(e =>
            e.source === selected || e.target === selected
              ? ({ ...e, data: { ...e.data!, quiet: false } } as FlowEdge)
              : ({ ...e, data: { ...e.data!, dim: true } } as FlowEdge)
          )
        : flow.edges,
    [flow, selected, near]
  );
  const latest = useRef(onSelect);
  latest.current = onSelect;
  const select = useCallback((id: string | null) => latest.current(id), []);
  const onNodeClick = useCallback(
    (_: unknown, n: AnyNode | FrameFlowNode) => n.type !== 'workflow' && select(n.id),
    [select]
  );
  const onPaneClick = useCallback(() => select(null), [select]);
  return (
    <SelectNode value={select}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesConnectable={false}
        onNodesChange={onNodesChange}
        onNodeDragStop={placed.onNodeDragStop}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        colorMode="system"
        fitView
        fitViewOptions={fitViewOptions}
        minZoom={0.2}
      >
        <Background />
        <Layers layer={layer} onChange={setLayer} />
        <GraphControls moved={placed.moved} onReset={placed.reset} />
        <FocusSelected id={selected} />
      </ReactFlow>
    </SelectNode>
  );
};
