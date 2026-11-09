import { Effect, Result, Stream } from 'effect';
import type { InstanceHost } from '@jannik-stacks/agi/trackers';
import type { DashboardData, DashboardSettings } from './data.ts';

export const readDashboard = (
  settings: typeof DashboardSettings.Type,
  { store, tracker }: Pick<InstanceHost, 'store' | 'tracker'>,
  now = new Date()
) =>
  Effect.gen(function* () {
    const runs = yield* store.listRecords();
    const needsChecks = settings.widgets.some(widget => widget.source === 'checks');
    const needsUsage = settings.widgets.some(widget => widget.source === 'tokens' || widget.source === 'cost');
    const records = yield* Effect.forEach(runs, run =>
      Effect.gen(function* () {
        const checks = needsChecks ? yield* store.readChecks(run.id) : [];
        const trace = needsUsage
          ? yield* Stream.runCollect(
              store.read(run.id).pipe(Stream.filter(line => 'event' in line && line.event.type === 'usage'))
            )
          : [];
        return { run, checks, trace };
      })
    );
    const today = Date.parse(now.toISOString().slice(0, 10));
    const issueDays = Math.max(0, ...settings.widgets.flatMap(widget => (widget.source === 'issues' ? [widget.days] : [])));
    const tracked = issueDays
      ? yield* Effect.result(
          Stream.runCollect(tracker.since(new Date(today - issueDays * 86_400_000).toISOString()))
        )
      : Result.succeed([]);
    const widgets = settings.widgets.map(widget => {
      const days = Array.from({ length: widget.days }, (_, i) =>
        new Date(today - (widget.days - i - 1) * 86_400_000).toISOString().slice(0, 10)
      );
      const series =
        widget.source === 'runs'
          ? ['running', 'waiting', 'done', 'stopped']
          : widget.source === 'checks'
            ? ['pass', 'fail']
            : widget.source === 'tokens'
              ? ['input', 'output']
              : widget.source === 'issues'
                ? ['comment', 'closed', 'merged']
                : ['USD'];
      const rows = days.flatMap(day => series.map(series => ({ day, series, value: 0 })));
      const lookup = new Map(rows.map(row => [`${row.day}/${row.series}`, row]));
      let skipped = 0;
      const isWithin = (at: string) => {
        const time = Date.parse(at);
        if (!Number.isFinite(time)) throw new Error(`Invalid dashboard timestamp: ${at}`);
        return time >= today - (widget.days - 1) * 86_400_000 && time <= now.getTime();
      };
      const add = (at: string, series: string, value: number) => {
        if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid dashboard value: ${value}`);
        const row = lookup.get(`${new Date(at).toISOString().slice(0, 10)}/${series}`);
        if (!row) throw new Error(`Unknown dashboard series: ${series}`);
        row.value += value;
      };
      if (widget.source === 'issues' && Result.isFailure(tracked)) skipped++;
      if (widget.source === 'issues')
        for (const event of Result.getOrElse(tracked, () => []))
          if ((event.kind === 'comment' || event.kind === 'closed' || event.kind === 'merged') && isWithin(event.at))
            add(event.at, event.kind, 1);
      for (const { run, checks, trace } of widget.source === 'issues' ? [] : records) {
        if (widget.workflow !== undefined && widget.workflow !== run.workflow) continue;
        if (widget.source === 'runs') {
          if ((widget.step === undefined || widget.step === run.step) && isWithin(run.started))
            add(run.started, run.status, 1);
        } else if (widget.source === 'checks') {
          for (const entry of checks)
            if ((widget.step === undefined || widget.step === entry.step) && isWithin(entry.at))
              add(entry.at, entry.check.pass ? 'pass' : 'fail', 1);
        } else {
          for (const line of trace) {
            if (!('event' in line) || line.event.type !== 'usage') continue;
            if ((widget.step !== undefined && widget.step !== line.step) || !isWithin(line.at)) continue;
            if (widget.source === 'tokens') {
              add(line.at, 'input', line.event.input);
              add(line.at, 'output', line.event.output);
            } else if (line.event.usd === undefined) skipped++;
            else add(line.at, 'USD', line.event.usd);
          }
        }
      }
      return {
        title: widget.title,
        type: widget.type,
        source: widget.source,
        rows,
        skipped,
        why:
          widget.source === 'issues'
            ? `Tracker unread: ${Result.isFailure(tracked) ? tracked.failure.message : ''}`
            : 'Usage events without a reported USD cost',
      };
    });
    return { at: now.toISOString(), widgets } satisfies typeof DashboardData.Type;
  });
