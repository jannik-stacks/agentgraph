import type { ReactNode } from 'react';
import type { GraphModel, GraphNode } from '../graph-model.ts';
import { Badge, Button } from '../ui.tsx';
import { heldBy } from './collapse.ts';
import { KindIcon } from './icons.tsx';
import { ItemList, type Row } from './ItemList.tsx';
import { FacetBadges } from './NodeCard.tsx';
import { NodeDetails } from './NodeDetails.tsx';

const RowBadges = ({ node }: { node: GraphNode }) => (
  <span className="ml-auto flex shrink-0 items-center gap-1">
    {node.badges?.map(badge => (
      <Badge key={badge.text} {...(badge.tone && { tone: badge.tone })}>
        {badge.text}
      </Badge>
    ))}
  </span>
);

/** Every node a stack holds, filterable, each row selecting its node. */
const StackDetails = ({
  stack,
  model,
  onSelect,
}: {
  stack: GraphNode;
  model: GraphModel;
  onSelect: (id: string | null) => void;
}) => {
  const byId = new Map(model.nodes.map(n => [n.id, n]));
  const owner = stack.stack && byId.get(stack.stack.owner);
  const rows = (stack.stack?.members ?? []).flatMap((id): Row[] => {
    const node = byId.get(id);
    return node
      ? [
          {
            key: id,
            label: node.label,
            icon: <KindIcon kind={node.kind} />,
            search: [node.detail?.summary, ...(node.badges?.map(b => b.text) ?? [])].join(' '),
            meta: <RowBadges node={node} />,
            onPick: () => onSelect(id),
          },
        ]
      : [];
  });
  return (
    <ItemList
      title={owner ? `${stack.label} of ${owner.label}` : stack.label}
      rows={rows}
      onBack={() => onSelect(null)}
    >
      <div className="flex flex-wrap items-center gap-1">
        {stack.stack?.facets.map(facet => (
          <FacetBadges key={facet.key} facet={facet} />
        ))}
      </div>
    </ItemList>
  );
};

/**
 * The details of what is selected in the graph: a stack's list, or the node's details with a way back to the stack
 * that holds it. `children` show while nothing is selected.
 */
export const Selection = ({
  model,
  shown,
  selected,
  onSelect,
  children,
}: {
  model: GraphModel;
  shown: GraphModel;
  selected: string | null;
  onSelect: (id: string | null) => void;
  children: ReactNode;
}) => {
  const stack = shown.nodes.find(n => n.id === selected && n.stack);
  if (stack) return <StackDetails stack={stack} model={model} onSelect={onSelect} />;
  const node = model.nodes.find(n => n.id === selected);
  if (!node) return children;
  const holder = shown.nodes.find(n => n.id === heldBy(shown).get(node.id));
  return (
    <>
      {holder && (
        <Button variant="small" className="mb-3" onClick={() => onSelect(holder.id)}>
          Back to {holder.label}
        </Button>
      )}
      <NodeDetails node={node} model={model} />
    </>
  );
};
