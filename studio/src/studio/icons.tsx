import type { ReactNode } from 'react';
import type { NodeKind, Tone } from '../graph-model.ts';
import { cx, tones } from '../ui.tsx';

/** Every kind of hub item the studio draws: the graph's node kinds, the workflow file that holds them and the hub. */
export type IconKind = NodeKind | 'workflow' | 'hub';

const shield = 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z';

/** The marks a check's shield can carry, one per outcome. */
export const checkMarks = {
  ok: 'm9 12 2 2 4-4',
  fail: 'm9.5 9.5 5 5m0-5-5 5',
  halt: 'M12 8v4m0 3.5v.01',
  skipped: 'M9 12h6',
  queued: 'M12 8.5V12l2 1.5',
};

const paths: Record<IconKind, ReactNode> = {
  trigger: <path d="M13 2 4 14h7l-1 8 9-12h-7z" />,
  workflow: (
    <>
      <rect x="3" y="3" width="8" height="8" rx="2" />
      <rect x="13" y="13" width="8" height="8" rx="2" />
      <path d="M7 11v4a2 2 0 0 0 2 2h4" />
    </>
  ),
  job: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="m10 8 6 4-6 4z" />
    </>
  ),
  bot: (
    <>
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path d="M12 8V4M9 4h6M2 14h2M20 14h2M9 13v2M15 13v2" />
    </>
  ),
  skill: (
    <>
      <path d="M12 7v14" />
      <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
    </>
  ),
  check: (
    <>
      <path d={shield} />
      <path d={checkMarks.ok} />
    </>
  ),
  script: (
    <>
      <path d="m4 17 6-6-6-6" />
      <path d="M12 19h8" />
    </>
  ),
  note: (
    <>
      <path d="M15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9z" />
      <path d="M15 3v6h6M7 13h6M7 17h8" />
    </>
  ),
  tool: (
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z" />
  ),
  issues: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </>
  ),
  hub: (
    <>
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
      <path d="M1 14h6M9 8h6M17 16h6" />
    </>
  ),
};

/** What each kind is, shown as the icon's tooltip. */
export const kindTitle: Record<IconKind, string> = {
  trigger: 'Trigger, an event that starts its workflow',
  workflow: 'Workflow, a file holding triggers and jobs',
  job: 'Job, one step: one bot with one skill, gated by checks',
  bot: 'Bot, who acts; reusable, referenced by jobs',
  skill: 'Skill, what to do; reusable, referenced by jobs',
  check: 'Check, a verdict that gates a job',
  script: 'Script, a shell command run as a step',
  note: 'Note, loaded automatically by rule',
  tool: 'Hub tool, read-only, served over MCP',
  issues: 'Issue tracker',
  hub: 'Hub settings',
};

export const kindText: Record<IconKind, string> = {
  trigger: 'text-violet-500',
  workflow: 'text-violet-600 dark:text-violet-400',
  job: 'text-sky-600 dark:text-sky-400',
  script: 'text-slate-500',
  bot: 'text-emerald-600 dark:text-emerald-400',
  skill: 'text-amber-600 dark:text-amber-400',
  check: 'text-rose-500',
  note: 'text-stone-500 dark:text-stone-400',
  issues: 'text-indigo-500',
  tool: 'text-cyan-600 dark:text-cyan-400',
  hub: 'text-zinc-500',
};

/**
 * The icon of a kind in its color, with what the kind is as the tooltip. A status takes the icon's place in the same
 * shape: `tone` recolors it, and a check given `mark` carries that outcome on its shield instead of the tick.
 */
export const KindIcon = ({
  kind,
  className = 'size-3.5',
  title = kindTitle[kind],
  mark,
  tone,
}: {
  kind: IconKind;
  className?: string;
  title?: string;
  mark?: keyof typeof checkMarks | undefined;
  tone?: Tone | undefined;
}) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}
    className={cx('shrink-0 transition-colors duration-300', tone ? tones[tone].text : kindText[kind], className)}
  >
    {title && <title>{title}</title>}
    {mark && kind === 'check' ? (
      <>
        <path d={shield} />
        <path d={checkMarks[mark]} />
      </>
    ) : (
      paths[kind]
    )}
  </svg>
);

const glyphs = {
  in: <path d="M12 4v16m-6-6 6 6 6-6" />,
  out: <path d="M12 20V4m-6 6 6-6 6 6" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  left: <path d="M19 12H5m6-6-6 6 6 6" />,
  right: <path d="M5 12h14m-6-6 6 6-6 6" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  pane: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M10 4v16" />
    </>
  ),
  modal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <rect x="7" y="8" width="10" height="8" rx="1" />
    </>
  ),
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
  schedule: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>
  ),
  push: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M3 12h6m6 0h6" />
    </>
  ),
  manual: <path d="m7 4 13 8-13 8z" />,
  retry: <path d="M3 12a9 9 0 0 1 15.5-6.3L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.3L3 16m0 5v-5h5" />,
  follow: (
    <>
      <circle cx="12" cy="12" r="2" />
      <path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19 5a10 10 0 0 1 0 14M5 19A10 10 0 0 1 5 5" />
    </>
  ),
  latest: <path d="M12 4v12m-5-5 5 5 5-5M5 20h14" />,
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
  cost: (
    <path d="M12 2v20M17 6.5C17 4.6 14.8 3.5 12 3.5S7 4.6 7 6.8c0 4.7 10 2.6 10 7.6 0 2.3-2.2 3.6-5 3.6s-5-1.2-5-3.2" />
  ),
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
  click: (
    <path d="M14 4.1 12 6M5.1 8l-2.9-.8M6 12l-1.9 2M7.2 2.2 8 5.1M9 9.7a.5.5 0 0 1 .7-.7l11 4.5a.5.5 0 0 1-.1 1l-4.3 1a1 1 0 0 0-.8.7l-1 4.4a.5.5 0 0 1-1 .1z" />
  ),
  link: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  model: (
    <>
      <path d="M12 3 4 7.5v9L12 21l8-4.5v-9z" />
      <path d="m4 7.5 8 4.5 8-4.5M12 12v9" />
    </>
  ),
};

export type Glyph = keyof typeof glyphs;

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
    className={cx('shrink-0', name === 'live' && 'motion-safe:animate-spin', className)}
  >
    {title && <title>{title}</title>}
    {glyphs[name]}
  </svg>
);
