import { useId } from 'react';

/** The bothub mark: a bot head with an antenna, drawn in `currentColor` with see-through eyes. */
export const Mark = ({ className }: { className?: string }) => {
  const mask = useId();
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden="true">
      <mask id={mask}>
        <rect width="16" height="16" fill="white" />
        <circle cx="5.5" cy="9.5" r="1.75" fill="black" />
        <circle cx="10.5" cy="9.5" r="1.75" fill="black" />
      </mask>
      <g fill="currentColor" mask={`url(#${mask})`}>
        <rect x="1" y="4.5" width="14" height="10.5" rx="3" />
        <rect x="7.25" y="1.5" width="1.5" height="3" />
        <circle cx="8" cy="1.75" r="1.5" />
      </g>
    </svg>
  );
};

export const Logo = () => (
  <span className="inline-flex items-center gap-1.5 font-semibold tracking-tight">
    <Mark className="size-5" />
    <span>bothub</span>
  </span>
);
