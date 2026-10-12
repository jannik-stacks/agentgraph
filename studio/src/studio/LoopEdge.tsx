import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react';

const reach = 56;
const gap = 28;

/** A back edge that leaves the source, runs underneath every node in between (`data.below`) and re-enters the target. */
export const LoopEdge = ({ sourceX, sourceY, targetX, targetY, label, style, markerEnd, data }: EdgeProps) => {
  const below = typeof data?.below === 'number' ? data.below : Math.max(sourceY, targetY);
  const bottom = below + gap;
  const path = [
    `M ${sourceX} ${sourceY}`,
    `C ${sourceX + reach} ${sourceY}, ${sourceX + reach} ${bottom}, ${sourceX} ${bottom}`,
    `L ${targetX} ${bottom}`,
    `C ${targetX - reach} ${bottom}, ${targetX - reach} ${targetY}, ${targetX} ${targetY}`,
  ].join(' ');
  return (
    <>
      <BaseEdge path={path} {...(style && { style })} {...(markerEnd && { markerEnd })} />
      {label && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan absolute rounded-full border border-orange-300 bg-orange-50 px-2 py-px text-[11px] text-orange-700 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-300"
            style={{ transform: `translate(-50%, -50%) translate(${(sourceX + targetX) / 2}px, ${bottom}px)` }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
};
