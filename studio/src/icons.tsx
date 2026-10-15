import { cx } from './ui.tsx';

const glyphs = {
  chevron: <path d="m9 6 6 6-6 6" />,
  ok: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  fail: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m9 9 6 6m0-6-6 6" />
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
  comment: <path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z" />,
  label: (
    <>
      <path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z" />
      <circle cx="8" cy="8" r="1.5" />
    </>
  ),
  pull: (
    <>
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M6 8v8M18 16V9a2 2 0 0 0-2-2h-5m2-3-3 3 3 3" />
    </>
  ),
  push: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M3 12h6m6 0h6" />
    </>
  ),
  expand: <path d="m7 9 5-5 5 5M7 15l5 5 5-5" />,
  collapse: <path d="m7 4 5 5 5-5M7 20l5-5 5 5" />,
  raw: (
    <path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1" />
  ),
  open: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  copy: (
    <>
      <rect x="8" y="8" width="13" height="13" rx="2" />
      <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
    </>
  ),
  tick: <path d="m5 12 5 5 9-10" />,
  time: (
    <>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9v4l2 2M9 2h6" />
    </>
  ),
  file: (
    <>
      <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" />
      <path d="M14 3v5h5" />
    </>
  ),
  question: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01" />
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
