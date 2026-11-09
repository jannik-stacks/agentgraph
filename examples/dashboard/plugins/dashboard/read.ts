import { Effect, Result, Stream } from 'effect';
import type { InstanceHost } from '@jannik-stacks/agi/plugins';
import { type DashboardSnapshot, type DashboardSettings, sources } from './data.ts';

const findDayStart = (today: number, daysBack: number) => today - daysBack * 86_400_000;

const formatDay = (time: number | string | Date) => new Date(time).toISOString().slice(0, 10);

const readTrackerEvents = (tracker: InstanceHost['tracker'], cursor: string) =>
  Stream.runCollect(tracker.since(cursor));

const trackerReads = new WeakMap<InstanceHost['tracker'], Map<string, ReturnType<typeof readTrackerEvents>>>();

const readCachedTrackerEvents = (tracker: InstanceHost['tracker'], cursor: string) => {
  const reads = trackerReads.get(tracker) ?? new Map<string, ReturnType<typeof readTrackerEvents>>();
  trackerReads.set(tracker, reads);
  const read = reads.get(cursor) ?? Effect.runSync(Effect.cachedWithTTL(readTrackerEvents(tracker, cursor), '1 minute'));
  reads.set(cursor, read);
  return read;
};

export const readDashboard = (
  settings: typeof DashboardSettings.Type,
  { store, tracker }: Pick<InstanceHost, 'store' | 'tracker'>,
  now = new Date()
) =>
  Effect.gen(function* () {
    const today = Date.parse(formatDay(now));
    const stored = settings.widgets.filter(widget => widget.source !== 'issues');
    const storeDays = Math.max(0, ...stored.map(widget => widget.days));
    const issueDays = Math.max(0, ...settings.widgets.flatMap(widget => (widget.source === 'issues' ? [widget.days] : [])));
    const oldest = new Date(findDayStart(today, storeDays - 1)).toISOString();
    const isWanted = (run: { workflow: string; ended?: string }) =>
      (run.ended === undefined || run.ended >= oldest) &&
      stored.some(widget => widget.workflow === undefined || widget.workflow === run.workflow);
    const needsChecks = stored.some(widget => widget.source === 'checks');
    const needsUsage = stored.some(widget => widget.source === 'tokens' || widget.source === 'cost');
    const { records, tracked } = yield* Effect.all(
      {
        records: Effect.flatMap(store.listRecords(), runs =>
          Effect.forEach(
            runs.filter(isWanted),
            run =>
              Effect.all({
                run: Effect.succeed(run),
                checks: needsChecks ? store.readChecks(run.id) : Effect.succeed([]),
                trace: needsUsage
                  ? Stream.runCollect(
                      store.read(run.id).pipe(Stream.filter(line => 'event' in line && line.event.type === 'usage'))
                    )
                  : Effect.succeed([]),
              }),
            { concurrency: 8 }
          )
        ),
        tracked: issueDays
          ? Effect.result(readCachedTrackerEvents(tracker, new Date(findDayStart(today, issueDays)).toISOString()))
          : Effect.succeed(Result.succeed([])),
      },
      { concurrency: 'unbounded' }
    );
    const widgets = settings.widgets.map(widget => {
      const start = findDayStart(today, widget.days - 1);
      const days = Array.from({ length: widget.days }, (_, i) => formatDay(findDayStart(today, widget.days - i - 1)));
      const { series } = sources[widget.source];
      const values = new Map<string, number>(days.flatMap(day => series.map(name => [`${day}/${name}`, 0])));
      let skipped = 0;
      let why = '';
      const add = (at: string, name: string, value: number) => {
        const time = Date.parse(at);
        const key = `${formatDay(Number.isFinite(time) ? time : 0)}/${name}`;
        if (time >= start && time <= now.getTime() && values.has(key)) values.set(key, values.get(key)! + value);
      };
      if (widget.source === 'issues' && Result.isFailure(tracked)) {
        skipped++;
        why = ['Tracker unread', tracked.failure.message].filter(Boolean).join(': ');
      }
      if (widget.source === 'issues')
        for (const event of Result.getOrElse(tracked, () => [])) add(event.at, event.kind, 1);
      for (const { run, checks, trace } of widget.source === 'issues' ? [] : records) {
        if (widget.workflow !== undefined && widget.workflow !== run.workflow) continue;
        if (widget.source === 'runs') {
          if (widget.step === undefined || widget.step === run.step) add(run.started, run.status, 1);
        } else if (widget.source === 'checks') {
          for (const entry of checks)
            if (widget.step === undefined || widget.step === entry.step)
              add(entry.at, entry.check.pass ? 'pass' : 'fail', 1);
        } else {
          for (const line of trace) {
            if (!('event' in line) || line.event.type !== 'usage') continue;
            if (widget.step !== undefined && widget.step !== line.step) continue;
            if (widget.source === 'tokens') {
              add(line.at, 'input', line.event.input);
              add(line.at, 'output', line.event.output);
            } else if (line.event.usd === undefined) {
              skipped++;
              why = 'Usage events without a reported USD cost';
            } else add(line.at, 'USD', line.event.usd);
          }
        }
      }
      return {
        title: widget.title,
        type: widget.type,
        source: widget.source,
        rows: days.flatMap(day => series.map(name => ({ day, series: name, value: values.get(`${day}/${name}`)! }))),
        skipped,
        why,
      };
    });
    return { at: now.toISOString(), widgets } satisfies typeof DashboardSnapshot.Type;
  });
