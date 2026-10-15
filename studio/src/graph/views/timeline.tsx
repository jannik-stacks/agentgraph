import type { ReactNode } from 'react';
import { accent, cx } from '../../ui.tsx';
import type { ViewProps } from './index.ts';
import { type End, storyOf, type Visit, visitsOf } from './visits.ts';

const marks = {
  fresh: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v8M8 12h8" />
    </>
  ),
  resumed: (
    <>
      <path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.6" />
      <path d="M4 4v4.6h4.6" />
    </>
  ),
  done: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  stopped: (
    <>
      <path d="M8 2h8l6 6v8l-6 6H8l-6-6V8z" />
      <path d="M8 12h8" />
    </>
  ),
  asking: (
    <path d="M18 11V6a2 2 0 0 0-4 0M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.3l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15" />
  ),
  waiting: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
};

const Mark = ({
  name,
  title,
  className = 'size-3.5',
}: {
  name: keyof typeof marks;
  title: string;
  className?: string;
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
    className={cx('shrink-0', className)}
  >
    <title>{title}</title>
    {marks[name]}
  </svg>
);

const sessionTitle = { fresh: 'new session', resumed: 'same session as before' };

/** One refused try: a short strike with its findings counted like an app badge. */
const Retry = ({ findings }: { findings: number }) => (
  <span
    title={`checks refused this try with ${findings} ${findings === 1 ? 'finding' : 'findings'}`}
    className="relative inline-flex h-4 w-5 items-center justify-center rounded-sm border border-zinc-300 text-[10px] text-zinc-500 dark:border-zinc-700"
  >
    ×
    <span className="absolute -top-1.5 -right-1.5 min-w-3.5 rounded-full bg-zinc-500 px-0.5 text-center text-[9px] leading-3.5 text-white dark:bg-zinc-400 dark:text-zinc-950">
      {findings}
    </span>
  </span>
);

const Box = ({ visit, now, end }: { visit: Visit; now: boolean; end?: End | undefined }) => {
  const { node, session, refused } = visit;
  const human = node.doer === 'human';
  const used = now && end?.kind === 'running' ? end.try : refused.length + (visit.left ? 1 : 0);
  const tryLine = node.tries > 1 && used > 0 ? `try ${used} of ${node.tries}` : undefined;
  const [bot, skill] = node.doer.split(' / ');
  const doer = human ? 'a human' : skill && skill !== node.step ? node.doer : bot;
  return (
    <div
      className={cx(
        'flex min-h-21 w-40 shrink-0 flex-col gap-1 rounded-md border bg-white px-2.5 py-2 text-xs dark:bg-zinc-950',
        now ? accent.border : 'border-zinc-300 dark:border-zinc-700',
        human && 'border-dashed'
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="truncate text-[13px] font-medium">{node.step}</span>
        {visit.nth > 1 && <span className="text-[10px] text-zinc-400">visit {visit.nth}</span>}
        {session && (
          <span className="ml-auto text-zinc-400">
            <Mark name={session} title={sessionTitle[session]} className="size-3" />
          </span>
        )}
      </div>
      <div className="truncate text-zinc-500">{doer}</div>
      {(refused.length > 0 || visit.left === 'pass' || (now && end?.kind === 'running')) && (
        <div className="flex items-center gap-2 pt-0.5">
          {refused.map((findings, i) => (
            <Retry key={i} findings={findings} />
          ))}
          {visit.left === 'pass' && <span className="text-zinc-500">✓</span>}
          {now && end?.kind === 'running' && <span className={cx('text-[11px]', accent.text)}>working</span>}
        </div>
      )}
      {tryLine && <div className={cx('text-[11px]', now ? accent.text : 'text-zinc-400')}>{tryLine}</div>}
      {now && end?.kind === 'waiting' && <div className={cx('text-[11px]', accent.text)}>waiting for you</div>}
      {visit.left === 'back' && <div className="text-[11px] text-zinc-500">sent it back</div>}
      {visit.outOfRounds && <div className="text-[11px] text-zinc-500">wanted another round, none left</div>}
    </div>
  );
};

/** The line between two visits: a plain arrow forward, a thin hooked line with the round when it went back. */
const Connector = ({ via }: { via?: Visit['via'] | undefined }) => (
  <div className="flex w-24 shrink-0 flex-col items-center justify-center gap-0.5 text-[10px] text-zinc-500">
    {via ? (
      <>
        <span>back from {via.from}</span>
        <svg viewBox="0 0 80 14" className="h-3.5 w-full text-zinc-400" fill="none" stroke="currentColor">
          <path d="M2 11 C 20 1, 60 1, 74 9" strokeDasharray="3 3" />
          <path d="m70 5 4 4-5 2" />
        </svg>
        <span title={via.why}>
          round {via.round}
          {via.of !== undefined && ` of ${via.of}`}
        </span>
      </>
    ) : (
      <svg viewBox="0 0 80 10" className="h-2.5 w-full text-zinc-400" fill="none" stroke="currentColor">
        <path d="M2 5h72M70 1l4 4-4 4" />
      </svg>
    )}
  </div>
);

const endings = {
  done: { mark: 'done', label: 'done' },
  stopped: { mark: 'stopped', label: 'stopped' },
  asking: { mark: 'asking', label: 'asking you' },
} as const;

const Ending = ({ end }: { end: End }) => {
  if (end.kind === 'running' || end.kind === 'waiting') return null;
  const { mark, label } = endings[end.kind];
  const live = end.kind !== 'done';
  return (
    <>
      <Connector />
      <div className={cx('flex max-w-48 shrink-0 items-start gap-1.5 text-xs', live ? accent.text : 'text-zinc-500')}>
        <Mark name={mark} title={label} className="size-5" />
        <div>
          <div className="font-medium">{label}</div>
          {'why' in end && end.why && <div className="line-clamp-3 text-[11px] text-zinc-500">{end.why}</div>}
        </div>
      </div>
    </>
  );
};

const Row = ({ children }: { children: ReactNode }) => (
  <div className="flex flex-wrap items-center gap-y-6 overflow-x-auto pb-2">{children}</div>
);

const Legend = () => (
  <div className="flex flex-wrap gap-4 text-[11px] text-zinc-500">
    <span className="flex items-center gap-1">
      <Mark name="fresh" title="new session" className="size-3" /> new session
    </span>
    <span className="flex items-center gap-1">
      <Mark name="resumed" title="same session" className="size-3" /> same session
    </span>
    <span className="flex items-center gap-1">
      <Retry findings={2} />
      <span className="ml-1">refused try, with findings</span>
    </span>
    <span className="flex items-center gap-1">
      <Mark name="stopped" title="stopped" className="size-3" /> stopped
    </span>
    <span className="flex items-center gap-1">
      <Mark name="asking" title="asking" className="size-3" /> asking you
    </span>
  </div>
);

/** The planned path: every step once, what may loop back, and the most sessions it can take. */
const Planned = ({ graph }: Pick<ViewProps, 'graph'>) => {
  const backs = graph.edges.filter(e => e.kind === 'back');
  return (
    <div className="space-y-4">
      <Row>
        {graph.nodes.map((node, i) => (
          <div key={node.step} className="flex items-center">
            {i > 0 && <Connector />}
            <div className="flex flex-col gap-1">
              <Box
                visit={{
                  node,
                  nth: 1,
                  ...(node.doer !== 'human' && node.doer !== 'script' && { session: 'fresh' as const }),
                  refused: [],
                  answered: 0,
                }}
                now={false}
              />
              <div className="w-40 text-[11px] text-zinc-400">
                {node.tries > 1 && <div>up to {node.tries} tries</div>}
                {node.checks.length > 0 && (
                  <div>
                    {node.checks.length} {node.checks.length === 1 ? 'check' : 'checks'}
                  </div>
                )}
                {backs
                  .filter(e => e.from === node.step)
                  .map(e => (
                    <div key={e.to}>
                      may send it back to {e.to}
                      {e.rounds !== undefined && `, up to ${e.rounds} ${e.rounds === 1 ? 'round' : 'rounds'}`}
                    </div>
                  ))}
              </div>
            </div>
          </div>
        ))}
        <Connector />
        <div className="flex items-center gap-1.5 text-xs text-zinc-500">
          <Mark name="done" title="done" className="size-5" /> done
        </div>
      </Row>
      <p className="text-[11px] text-zinc-400">
        Worst case: {graph.worst} {graph.worst === 1 ? 'session' : 'sessions'} before it asks you.
      </p>
    </div>
  );
};

/** A run unrolled into the visits it made, left to right, ending in done, stopped or a question for you. */
export default function Timeline({ graph, run, trail }: ViewProps) {
  if (!run || !trail) return <Planned graph={graph} />;
  const unrolled = visitsOf(graph, trail, run);
  const { visits, end } = unrolled;
  const open = end.kind === 'running' || end.kind === 'waiting' || end.kind === 'asking';
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm">{storyOf(unrolled)}</p>
      <Row>
        {visits.map((visit, i) => (
          <div key={i} className="flex items-center">
            {i > 0 && <Connector via={visit.via} />}
            <Box visit={visit} now={open && i === visits.length - 1} end={end} />
          </div>
        ))}
        <Ending end={end} />
      </Row>
      <Legend />
    </div>
  );
}
