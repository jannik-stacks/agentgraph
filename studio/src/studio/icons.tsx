import type { ReactNode } from 'react';
import type { NodeKind } from '../graph-model.ts';
import { cx } from '../ui.tsx';

/** Every kind of hub item the studio draws: the graph's node kinds, the workflow file that holds them and the hub. */
export type IconKind = NodeKind | 'workflow' | 'hub';

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
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
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

/** The icon of a kind in its color, with what the kind is as the tooltip. */
export const KindIcon = ({
  kind,
  className = 'size-3.5',
  title = kindTitle[kind],
}: {
  kind: IconKind;
  className?: string;
  title?: string;
}) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    role="img"
    aria-label={title}
    className={cx('shrink-0', kindText[kind], className)}
  >
    <title>{title}</title>
    {paths[kind]}
  </svg>
);
