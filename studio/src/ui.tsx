import type { ReactNode } from 'react';
import type { RunStatus } from '../../src/store.ts';
import type { Tone } from './graph-model.ts';

export const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ');

const tones: Record<Tone, string> = {
  neutral: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
  info: 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
  ok: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  warn: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  danger: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
};

const statusTones: Partial<Record<RunStatus, Tone>> = { queued: 'neutral', running: 'info', succeeded: 'ok' };
export const statusTone = (status: RunStatus): Tone => statusTones[status] ?? 'danger';

export const Badge = ({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) => (
  <span
    className={cx(
      'inline-block rounded px-1.5 py-px text-[10px] font-medium normal-case leading-4 tracking-normal',
      tones[tone]
    )}
  >
    {children}
  </span>
);

export const Field = ({ name, children }: { name: string; children: ReactNode }) => (
  <>
    <dt className="text-zinc-500">{name}</dt>
    <dd className="min-w-0 break-words">{children}</dd>
  </>
);

export const Fields = ({ children }: { children: ReactNode }) => (
  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">{children}</dl>
);

export const Pre = ({ children }: { children: ReactNode }) => (
  <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-zinc-100 p-2 font-mono text-xs dark:bg-zinc-900">
    {children}
  </pre>
);

export const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="space-y-2">
    <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</h3>
    {children}
  </section>
);

export const Muted = ({ children }: { children: ReactNode }) => <p className="p-4 text-zinc-500">{children}</p>;

export const list = (items: readonly string[] | undefined) => (items?.length ? items.join(', ') : '-');
