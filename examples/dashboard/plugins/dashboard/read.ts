import { isAbsolute } from 'node:path';
import { Effect, Stream } from 'effect';
import { Store, fileStore } from '../../../../src/store.ts';
import type { DashboardData, DashboardSettings } from './data.ts';

export const readDashboard = (settings: typeof DashboardSettings.Type, now = new Date()) =>
  Effect.gen(function* () {
    if (!isAbsolute(settings.data)) return yield* Effect.fail(new Error('dashboard.data must be an absolute path'));
    const store = yield* Store;
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
      for (const { run, checks, trace } of records) {
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
        why: 'Usage events without a reported USD cost',
      };
    });
    return { at: now.toISOString(), widgets } satisfies typeof DashboardData.Type;
  }).pipe(Effect.provide(fileStore(settings.data)));
