import type { EventRecord } from '../../../../src/store.ts';
import type { AgentEvent } from '../../../../src/types.ts';
import { Icon } from '../../icons.tsx';
import { Tooltip } from '../../ui.tsx';

type Decision = Extract<AgentEvent, { type: 'decision' }>;

/** The decider's answers in a run, in order. */
export const decisionsOf = (records: EventRecord[]) =>
  records.flatMap(({ seq, event }) => (event.type === 'decision' ? [{ seq, event }] : []));

const where = (d: Decision) =>
  d.on === 'stop' ? 'final message' : `${d.tool ?? 'tool'} ${d.on === 'tool_call' ? 'call' : 'result'}`;

const tip = (d: Decision) =>
  [
    d.ask,
    d.p !== undefined && `Probability of yes ${d.p.toFixed(3)}`,
    d.threshold !== undefined ? `Threshold ${d.threshold}` : 'Log mode, records only',
    d.acted && (d.on === 'tool_call' ? 'Denied the call' : 'Added a nudge'),
    d.error && `Decision model unavailable: ${d.error}`,
    d.call && `Tool call ${d.call}`,
  ]
    .filter(Boolean)
    .join('\n');

export const DecidedHead = ({ decisions }: { decisions: { event: Decision }[] }) => {
  const acted = decisions.filter(d => d.event.acted).length;
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <Tooltip tip="What the decider asked the decision model during the run">
        <Icon name="ok" className="size-3 text-zinc-400" />
      </Tooltip>
      <span className="text-zinc-700 dark:text-zinc-300">Decided</span>
      <span className="ml-auto text-zinc-500 tabular-nums">
        {decisions.length} {decisions.length === 1 ? 'answer' : 'answers'}
        {acted > 0 && `, ${acted} acted`}
      </span>
    </span>
  );
};

/** One row per answer: where it was asked, the question, and the probability of yes. */
export const DecidedRows = ({ decisions }: { decisions: { seq: number; event: Decision }[] }) => (
  <ul className="space-y-0.5 py-1 pr-2 text-xs">
    {decisions.map(({ seq, event }) => (
      <li key={seq} className="flex min-w-0 items-center gap-2 py-0.5">
        <span className="shrink-0 font-mono">{where(event)}</span>
        <Tooltip tip={tip(event)} className="min-w-0 flex-1">
          <span className="block min-w-0 truncate text-zinc-500">{event.ask}</span>
        </Tooltip>
        <span
          className={
            event.acted ? 'shrink-0 text-sky-600 tabular-nums dark:text-sky-400' : 'shrink-0 text-zinc-500 tabular-nums'
          }
        >
          {event.p === undefined ? 'unanswered' : event.p.toFixed(2)}
        </span>
      </li>
    ))}
  </ul>
);
