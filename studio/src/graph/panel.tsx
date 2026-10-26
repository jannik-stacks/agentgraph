import { useSetAtom } from 'jotai';
import { useEffect } from 'react';
import { Icon } from '../icons.tsx';
import { selectedStepAtom } from '../state.ts';
import { cx, IconButton, Tooltip } from '../ui.tsx';

export const Section = ({ title, tip, children }: { title: string; tip?: string; children: React.ReactNode }) => (
  <section className="space-y-1.5">
    <h3 className="font-medium text-zinc-500">{tip ? <Term tip={tip}>{title}</Term> : title}</h3>
    {children}
  </section>
);

export const Term = ({ tip, children }: { tip: string; children: React.ReactNode }) => (
  <Tooltip tip={tip}>
    <span className="cursor-help underline decoration-zinc-200 decoration-dotted underline-offset-3 hover:decoration-zinc-400 dark:decoration-zinc-700">
      {children}
    </span>
  </Tooltip>
);

export const To = ({ path, className, children }: { path: string; className?: string; children: React.ReactNode }) => {
  const select = useSetAtom(selectedStepAtom);
  return (
    <button
      type="button"
      onClick={() => select(path)}
      className={cx(
        'font-mono text-zinc-900 underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-600 dark:text-zinc-100 dark:decoration-zinc-600 dark:hover:decoration-zinc-300',
        className
      )}
    >
      {children}
    </button>
  );
};

export const Crumbs = ({ path }: { path: string }) => {
  const select = useSetAtom(selectedStepAtom);
  const parts = path.split('/');
  const up = parts.slice(0, -1).join('/');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && select(up);
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [select, up]);
  const levels = parts
    .slice(1)
    .map((part, i) => ({ name: part.split(':').at(-1)!, path: parts.slice(0, i + 2).join('/') }));
  return (
    <div className="flex items-center gap-1.5">
      <IconButton tip={`Back to ${levels.at(-2)?.name}`} variant="quiet" onClick={() => select(up)}>
        <Icon name="back" className="size-3.5" />
      </IconButton>
      <nav aria-label="Breadcrumbs" className="flex min-w-0 items-center gap-1 text-sm">
        {levels.slice(0, -1).map(level => (
          <span key={level.path} className="flex min-w-0 items-center gap-1">
            <button
              type="button"
              onClick={() => select(level.path)}
              className="truncate text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
            >
              {level.name}
            </button>
            <Icon name="chevron" className="size-3 shrink-0 text-zinc-400" />
          </span>
        ))}
        <h2 className="truncate font-mono font-semibold">{levels.at(-1)?.name}</h2>
      </nav>
    </div>
  );
};

export const gates = {
  warn: 'A failure is recorded and never holds the step.',
  block: 'A failure fails the try, and the output goes back as feedback.',
  stop: 'A failure stops the run.',
};
