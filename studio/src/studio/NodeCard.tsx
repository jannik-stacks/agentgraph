import { Handle, type Node, type NodeProps, Position } from '@xyflow/react';
import { useAtomValue, useSetAtom } from 'jotai';
import { createContext, memo, type ReactNode, use } from 'react';
import { fanOut } from '../../../src/over.ts';
import { type GraphNode, modeTone } from '../graph-model.ts';
import { editPathAtom, navigateAtom } from '../state.ts';
import { Badge, cx, Tooltip } from '../ui.tsx';
import { plural } from './collapse.ts';
import { castSize, nodeSize, stackSize } from './layout.ts';
import { Icon, KindIcon, kindTitle } from './icons.tsx';
import { nodeStyle } from './styles.ts';

export type FlowNode = Node<{ node: GraphNode }, 'graph' | 'cast'>;
export type StackFlowNode = Node<{ node: GraphNode; held: GraphNode[] }, 'stack'>;
export type JobFlowNode = Node<{ node: GraphNode; bot?: GraphNode | undefined; skill?: GraphNode | undefined }, 'job'>;

/** Selects a node by id; cards use it for the chips inside them. */
export const SelectNode = createContext<(id: string) => void>(() => {});

const hidden = '!pointer-events-none !min-h-0 !min-w-0 !h-px !w-px !border-0 !bg-transparent';

const stacked =
  'shadow-[3px_3px_0_-1px_var(--color-white),3px_3px_0_0_var(--color-zinc-300),6px_6px_0_-1px_var(--color-white),6px_6px_0_0_var(--color-zinc-300)] dark:shadow-[3px_3px_0_-1px_var(--color-zinc-900),3px_3px_0_0_var(--color-zinc-600),6px_6px_0_-1px_var(--color-zinc-900),6px_6px_0_0_var(--color-zinc-600)]';

const forEachOf = (node: GraphNode) => fanOut(node.data?.over as Parameters<typeof fanOut>[0]);

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

const PerEach = ({ node }: { node: GraphNode }) => {
  const forEach = forEachOf(node);
  return forEach ? (
    <Badge tone="info">
      <span className="whitespace-nowrap">each {forEach}</span>
    </Badge>
  ) : null;
};

const Badges = ({ badges }: { badges: GraphNode['badges'] }) =>
  badges?.map(badge => (
    <Badge key={badge.text} {...(badge.tone && { tone: badge.tone })}>
      <span className="block max-w-[9rem] truncate">{badge.text}</span>
    </Badge>
  ));

const Meta = ({ children }: { children: ReactNode }) => (
  <div className="flex min-w-0 items-center gap-1 overflow-hidden font-sans">{children}</div>
);

const Title = ({ node }: { node: GraphNode }) => (
  <div className="flex min-w-0 items-center gap-1.5">
    <KindIcon kind={node.kind} />
    <span className="truncate text-[13px] font-semibold">{node.label}</span>
  </div>
);

/** A trigger, script or check. */
export const NodeCard = memo(({ data: { node }, selected }: NodeProps<FlowNode>) => (
  <Card node={node} selected={selected} size={nodeSize}>
    <Title node={node} />
    <Meta>
      <PerEach node={node} />
      <Badges badges={node.badges} />
    </Meta>
    {node.detail?.summary && (
      <div className="truncate font-sans text-[11px] text-zinc-500 dark:text-zinc-400">{node.detail.summary}</div>
    )}
  </Card>
));

const castChip = {
  bot: 'border-emerald-200 bg-emerald-50 text-emerald-900 hover:border-emerald-400 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-100 dark:hover:border-emerald-600',
  skill:
    'border-amber-200 bg-amber-50 text-amber-900 hover:border-amber-400 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-100 dark:hover:border-amber-600',
};

const CastChip = ({ node, kind }: { node: GraphNode; kind: keyof typeof castChip }) => {
  const select = use(SelectNode);
  return (
    <button
      type="button"
      title={`${kindTitle[kind]}\n${kind} ${node.label}`}
      onClick={e => {
        e.stopPropagation();
        select(node.id);
      }}
      className={cx(
        'nodrag inline-flex min-w-0 items-center gap-1 rounded border px-1 font-sans text-[11px] leading-4',
        castChip[kind]
      )}
    >
      <KindIcon kind={kind} className="size-3" title={kind} />
      <span className="truncate">{node.label}</span>
    </button>
  );
};

/** A job: one step, naming the bot it casts and the skill it hands that bot. */
export const JobCard = memo(({ data: { node, bot, skill }, selected }: NodeProps<JobFlowNode>) => (
  <Card node={node} selected={selected} size={nodeSize}>
    <Title node={node} />
    <Meta>
      <PerEach node={node} />
      <Badges badges={[...(node.badges?.filter(badge => badge.tone) ?? []), ...(bot?.badges ?? [])]} />
    </Meta>
    {(bot || skill) && (
      <div className="flex min-w-0 items-center gap-1 overflow-hidden">
        {bot && <CastChip node={bot} kind="bot" />}
        {skill && <CastChip node={skill} kind="skill" />}
      </div>
    )}
  </Card>
));

/** A bot or a skill, small, placed under the steps that cast it. */
export const CastCard = memo(({ data: { node }, selected }: NodeProps<FlowNode>) => (
  <Card node={node} selected={selected} size={castSize}>
    <div className="flex min-w-0 items-center gap-1">
      <KindIcon kind={node.kind} className="size-3" />
      <span className="truncate text-xs font-semibold leading-4">{node.label}</span>
    </div>
    {node.badges?.length ? (
      <div className="truncate font-sans text-[10px] leading-3 text-zinc-500 dark:text-zinc-400">
        {node.badges.map(b => b.text).join(', ')}
      </div>
    ) : null}
  </Card>
));

export const FacetBadges = ({ facet }: { facet: NonNullable<GraphNode['stack']>['facets'][number] | undefined }) =>
  facet?.counts.map(([value, count]) => {
    const tone = facet.key === 'mode' ? modeTone[value as keyof typeof modeTone] : undefined;
    return (
      <Badge key={value} {...(tone && { tone })}>
        <span className="whitespace-nowrap tabular-nums">
          {count} {value}
        </span>
      </Badge>
    );
  });

/** The nodes a crowded group folds away, as one short stacked card counting them by their first facet. */
export const StackCard = memo(({ data: { node, held }, selected }: NodeProps<StackFlowNode>) => (
  <div
    style={stackSize}
    className={cx(
      'relative flex cursor-pointer flex-col justify-center gap-1 border border-l-4 border-zinc-200 bg-white px-2.5 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100',
      nodeStyle[node.kind],
      stacked,
      selected && 'ring-2 ring-sky-400'
    )}
  >
    <span
      aria-hidden
      className="absolute -top-px -bottom-px -left-1 w-1 rounded-l-[inherit] [--tint:rgb(255_255_255/0.7)] dark:[--tint:rgb(24_24_27/0.75)]"
      style={{ background: 'repeating-linear-gradient(45deg, transparent 0 3px, var(--tint) 3px 6px)' }}
    />
    <Handle type="target" position={Position.Left} isConnectable={false} className={hidden} />
    <div className="flex min-w-0 items-center gap-1.5 pr-10">
      <KindIcon kind={node.kind} />
      <span className="truncate text-[13px] font-semibold tabular-nums">{node.label}</span>
    </div>
    <Meta>
      <FacetBadges facet={node.stack?.facets[0]} />
    </Meta>
    <Tooltip
      tip={`${held.length} more ${plural(node.kind)}, click to list them`}
      className="absolute top-1.5 right-1.5"
    >
      <span className="inline-flex items-center gap-0.5 rounded-full bg-zinc-100 px-1.5 text-[10px] leading-4 font-medium text-zinc-500 tabular-nums dark:bg-zinc-800 dark:text-zinc-400">
        {held.length}
        <Icon name="more" className="size-3" />
      </span>
    </Tooltip>
    <Handle type="source" position={Position.Right} isConnectable={false} className={hidden} />
  </div>
));

export type FrameFlowNode = Node<{ name: string; path?: string | undefined }, 'workflow'>;

/** The frame drawn around one workflow's triggers, jobs and gating checks, titled with its name and file. */
export const WorkflowFrame = memo(({ data: { name, path } }: NodeProps<FrameFlowNode>) => {
  const navigate = useSetAtom(navigateAtom);
  const editing = useAtomValue(editPathAtom) === path;
  const title = (
    <>
      <KindIcon kind="workflow" />
      <span className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">{name}</span>
      {path && <span className="truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{path}</span>}
    </>
  );
  return (
    <div
      className={cx(
        'relative size-full rounded-xl border bg-violet-50/40 dark:bg-violet-950/15',
        editing ? 'border-violet-400 dark:border-violet-500' : 'border-violet-200 dark:border-violet-900'
      )}
    >
      {path ? (
        <button
          type="button"
          title={`${kindTitle.workflow}\nEdit ${path}`}
          onClick={e => {
            e.stopPropagation();
            navigate({ query: { edit: path, node: null } });
          }}
          className="nodrag pointer-events-auto absolute left-2 top-1.5 flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-violet-100 dark:hover:bg-violet-900/50"
        >
          {title}
        </button>
      ) : (
        <div className="absolute left-2 top-1.5 flex items-center gap-1.5 px-1.5 py-0.5">{title}</div>
      )}
    </div>
  );
});
