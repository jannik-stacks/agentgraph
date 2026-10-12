import { useAtomValue, useSetAtom } from 'jotai';
import type { Run } from '../../../src/store.ts';
import { needsHumanQueryAtom, runDetailAtom, runDetailQueryAtom, runsQueryAtom } from '../state.ts';
import { Badge, Field, Fields, Section, statusTone } from '../ui.tsx';
import { EventLog } from './EventLog.tsx';
import { OutcomePanel } from './OutcomePanel.tsx';
import { cost } from './RunTable.tsx';
import { useEventStream } from './useEventStream.ts';

const RunSummary = ({ run }: { run: Run }) => (
  <Fields>
    <Field name="status">
      <Badge tone={statusTone(run.status)}>{run.status}</Badge>
    </Field>
    <Field name="job">
      {run.workflow} / {run.job}
    </Field>
    <Field name="bot">
      {run.bot ?? '-'}
      {run.harness && ` (${run.harness})`}
    </Field>
    <Field name="event">
      {run.event.trigger}
      {run.event.action && `.${run.event.action}`} on {run.event.repo}
      {run.event.number !== undefined && `#${run.event.number}`} by {run.event.actor.login}
    </Field>
    <Field name="cost">
      {cost(run.costUsd)}
      {run.turns !== undefined && `, ${run.turns} turns`}
    </Field>
    {run.error && <Field name="error">{run.error}</Field>}
    <Field name="id">
      <span className="font-mono text-xs">{run.id}</span>
    </Field>
  </Fields>
);

/** A run's summary, its live event log and its outcome. Key it by run id. */
export const RunDetail = ({ id }: { id: string }) => {
  const detail = useAtomValue(runDetailAtom);
  const refreshDetail = useSetAtom(runDetailQueryAtom);
  const refreshRuns = useSetAtom(runsQueryAtom);
  const refreshNeedsHuman = useSetAtom(needsHumanQueryAtom);
  const stream = useEventStream(id, () => {
    refreshDetail();
    refreshRuns();
    refreshNeedsHuman();
  });
  const current = detail?.run.id === id ? detail : undefined;

  return (
    <div className="grid gap-6 p-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0 space-y-4">
        {current && <RunSummary run={current.run} />}
        <Section title={stream.done ? 'events' : 'events (live)'}>
          {stream.records.length ? (
            <EventLog records={stream.records} />
          ) : (
            <p className="text-zinc-500">No events yet.</p>
          )}
          {stream.error && <p className="text-amber-600">Reconnecting to the event stream.</p>}
        </Section>
      </div>
      <aside className="min-w-0">
        {current?.outcome ? (
          <OutcomePanel outcome={current.outcome} />
        ) : (
          <p className="text-zinc-500">
            {stream.done ? 'This run has no outcome.' : 'The outcome appears when the run ends.'}
          </p>
        )}
      </aside>
    </div>
  );
};
