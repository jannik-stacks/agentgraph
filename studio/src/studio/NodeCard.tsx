import { Handle, type Node, type NodeProps, Position } from '@xyflow/react';
import { createContext, memo, type ReactNode, use } from 'react';
import type { GraphNode } from '../graph-model.ts';
import { Badge, cx } from '../ui.tsx';
import { castSize, nodeSize } from './layout.ts';
import { kindDot, nodeStyle } from './styles.ts';

export type FlowNode = Node<{ node: GraphNode }, 'graph' | 'cast'>;
export type JobFlowNode = Node<{ node: GraphNode; bot?: GraphNode | undefined; skill?: GraphNode | undefined }, 'job'>;

/** Selects a node by id; cards use it for the chips inside them. */
export const SelectNode = createContext<(id: string) => void>(() => {});

const hidden = '!pointer-events-none !min-h-0 !min-w-0 !h-px !w-px !border-0 !bg-transparent';

const stacked =
  'shadow-[3px_3px_0_-1px_var(--color-white),3px_3px_0_0_var(--color-zinc-300),6px_6px_0_-1px_var(--color-white),6px_6px_0_0_var(--color-zinc-300)] dark:shadow-[3px_3px_0_-1px_var(--color-zinc-900),3px_3px_0_0_var(--color-zinc-600),6px_6px_0_-1px_var(--color-zinc-900),6px_6px_0_0_var(--color-zinc-600)]';

const forEachOf = (node: GraphNode) =>
  typeof node.data?.['for-each'] === 'string' ? node.data['for-each'] : undefined;

const Card = ({
  node,
  selected,
  size,
  children,
}: {
  node: GraphNode;
  selected: boolean;
  size: { width: number; height: number };
  children: ReactNode;
}) => (
  <div
    style={size}
    title={[node.label, node.detail?.summary].filter(Boolean).join('\n')}
    className={cx(
      'flex flex-col justify-center gap-0.5 border border-l-4 border-zinc-200 bg-white px-2.5 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100',
      nodeStyle[node.kind],
      forEachOf(node) ? stacked : 'shadow-sm',
      selected && 'ring-2 ring-sky-400'
    )}
  >
    <Handle type="target" position={Position.Left} isConnectable={false} className={hidden} />
    {children}
    <Handle type="source" position={Position.Right} isConnectable={false} className={hidden} />
  </div>
);

const Kind = ({ node, children }: { node: GraphNode; children?: ReactNode }) => {
  const forEach = forEachOf(node);
  return (
    <div className="flex min-w-0 items-center gap-1.5 overflow-hidden font-sans text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
      <span className="shrink-0">{node.kind}</span>
      {forEach && (
        <Badge tone="info">
          <span className="whitespace-nowrap">per {forEach}</span>
        </Badge>
      )}
      {children}
    </div>
  );
};

const Badges = ({ badges }: { badges: GraphNode['badges'] }) =>
  badges?.map(badge => (
    <Badge key={badge.text} {...(badge.tone && { tone: badge.tone })}>
      <span className="block max-w-[9rem] truncate">{badge.text}</span>
    </Badge>
  ));

const Label = ({ node }: { node: GraphNode }) => <div className="truncate text-[13px] font-semibold">{node.label}</div>;

/** A trigger, script or check. */
export const NodeCard = memo(({ data: { node }, selected }: NodeProps<FlowNode>) => (
  <Card node={node} selected={selected} size={nodeSize}>
    <Kind node={node}>
      <Badges badges={node.badges} />
    </Kind>
    <Label node={node} />
    {node.detail?.summary && (
      <div className="truncate font-sans text-[11px] text-zinc-500 dark:text-zinc-400">{node.detail.summary}</div>
    )}
  </Card>
));

const CastChip = ({ node }: { node: GraphNode }) => {
  const select = use(SelectNode);
  return (
    <button
      type="button"
      title={`${node.kind} ${node.label}`}
      onClick={e => {
        e.stopPropagation();
        select(node.id);
      }}
      className="nodrag inline-flex min-w-0 items-center gap-1 rounded border border-zinc-200 px-1 font-sans text-[11px] leading-4 text-zinc-700 hover:border-sky-400 hover:text-sky-700 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-sky-600 dark:hover:text-sky-300"
    >
      <span className={cx('size-1.5 shrink-0 rounded-full', kindDot[node.kind])} />
      <span className="truncate">{node.label}</span>
    </button>
  );
};

/** A job: one step, naming the bot it casts and the skill it hands that bot. */
export const JobCard = memo(({ data: { node, bot, skill }, selected }: NodeProps<JobFlowNode>) => (
  <Card node={node} selected={selected} size={nodeSize}>
    <Kind node={node}>
      <Badges badges={[...(node.badges?.filter(badge => badge.tone) ?? []), ...(bot?.badges ?? [])]} />
    </Kind>
    <Label node={node} />
    {(bot || skill) && (
      <div className="flex min-w-0 items-center gap-1 overflow-hidden">
        {bot && <CastChip node={bot} />}
        {skill && <CastChip node={skill} />}
      </div>
    )}
  </Card>
));

/** A bot or a skill, small, placed under the steps that cast it. */
export const CastCard = memo(({ data: { node }, selected }: NodeProps<FlowNode>) => (
  <Card node={node} selected={selected} size={castSize}>
    <div className="truncate font-sans text-[9px] uppercase leading-3 tracking-wide text-zinc-500 dark:text-zinc-400">
      {node.kind}
      {node.badges?.length ? ` ${node.badges.map(b => b.text).join(' ')}` : ''}
    </div>
    <div className="truncate text-xs font-semibold leading-4">{node.label}</div>
  </Card>
));
