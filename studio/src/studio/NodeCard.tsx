import { Handle, type Node, type NodeProps, Position } from '@xyflow/react';
import type { GraphNode } from '../graph-model.ts';
import { Badge, cx } from '../ui.tsx';
import { nodeSize } from './layout.ts';
import { nodeStyle } from './styles.ts';

export type FlowNode = Node<{ node: GraphNode }, 'graph'>;

const hidden = '!pointer-events-none !min-h-0 !min-w-0 !h-px !w-px !border-0 !bg-transparent';

const stacked =
  'shadow-[3px_3px_0_-1px_var(--color-white),3px_3px_0_0_var(--color-zinc-300),6px_6px_0_-1px_var(--color-white),6px_6px_0_0_var(--color-zinc-300)] dark:shadow-[3px_3px_0_-1px_var(--color-zinc-900),3px_3px_0_0_var(--color-zinc-600),6px_6px_0_-1px_var(--color-zinc-900),6px_6px_0_0_var(--color-zinc-600)]';

export const NodeCard = ({ data: { node }, selected }: NodeProps<FlowNode>) => {
  const forEach = typeof node.data?.['for-each'] === 'string' ? node.data['for-each'] : undefined;
  return (
    <div
      style={nodeSize}
      title={[node.label, node.detail?.summary].filter(Boolean).join('\n')}
      className={cx(
        'flex flex-col justify-center gap-0.5 border border-l-4 border-zinc-200 bg-white px-2.5 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100',
        nodeStyle[node.kind],
        forEach ? stacked : 'shadow-sm',
        selected && 'ring-2 ring-sky-400'
      )}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} className={hidden} />
      <div className="flex min-w-0 items-center gap-1.5 overflow-hidden font-sans text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        <span className="shrink-0">{node.kind}</span>
        {forEach && (
          <Badge tone="info">
            per {forEach}
          </Badge>
        )}
        {node.badges?.map(badge => (
          <Badge key={badge.text} {...(badge.tone && { tone: badge.tone })}>
            <span className="block max-w-[9rem] truncate">{badge.text}</span>
          </Badge>
        ))}
      </div>
      <div className="truncate text-[13px] font-semibold">{node.label}</div>
      {node.detail?.summary && (
        <div className="truncate font-sans text-[11px] text-zinc-500 dark:text-zinc-400">{node.detail.summary}</div>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} className={hidden} />
    </div>
  );
};
