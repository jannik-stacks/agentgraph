import { useId } from 'react';
import { cx } from './ui.tsx';

/** The agentgraph mark: a bot head with an antenna, in the current text color with see-through eyes. */
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

const glyphs = {
  ok: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  queued: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  skipped: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12h8" />
    </>
  ),
  live: <path d="M21 12a9 9 0 1 1-9-9" />,
  expand: <path d="m7 9 5-5 5 5M7 15l5 5 5-5" />,
  collapse: <path d="m7 4 5 5 5-5M7 20l5-5 5 5" />,
  copy: (
    <>
      <rect x="8" y="8" width="13" height="13" rx="2" />
      <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
    </>
  ),
  tick: <path d="m5 12 5 5 9-10" />,
  file: (
    <>
      <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" />
      <path d="M14 3v5h5" />
    </>
  ),
};

type Glyph = keyof typeof glyphs;

/**
 * A small interface icon in the current text color. With `title` it is labelled and shows a tooltip; without, it is
 * decoration next to text that says the same.
 */
export const Icon = ({ name, className = 'size-3.5', title }: { name: Glyph; className?: string; title?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}
    className={cx('shrink-0', className)}
  >
    {title && <title>{title}</title>}
    {glyphs[name]}
  </svg>
);

/** A small pulsing dot in the current text color, for a run that is working now. */
export const Pulse = () => <span aria-hidden className="inline-block size-1.5 animate-pulse rounded-full bg-current" />;
