import { Handle, type Node, type NodeProps, Position } from '@xyflow/react';
import type { GraphNode } from '../graph-model.ts';
import { Badge, cx } from '../ui.tsx';
import { nodeSize } from './layout.ts';
import { nodeStyle } from './styles.ts';

export type FlowNode = Node<{ node: GraphNode }, 'graph'>;

export const NodeCard = ({ data: { node }, selected }: NodeProps<FlowNode>) => (
  <div
    style={nodeSize}
    className={cx(
      'flex flex-col justify-center gap-0.5 border border-l-4 border-zinc-200 bg-white px-2.5 text-xs shadow-sm dark:border-zinc-700 dark:bg-zinc-900',
      nodeStyle[node.kind],
      selected && 'ring-2 ring-sky-400'
    )}
  >
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <div className="flex items-center gap-1.5 font-sans text-[10px] uppercase tracking-wide text-zinc-500">
      {node.kind}
      {node.badges?.map(badge => (
        <Badge key={badge.text} {...(badge.tone && { tone: badge.tone })}>
          {badge.text}
        </Badge>
      ))}
    </div>
    <div className="truncate font-semibold">{node.label}</div>
    {node.detail?.summary && <div className="truncate font-sans text-[11px] text-zinc-500">{node.detail.summary}</div>}
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </div>
);
