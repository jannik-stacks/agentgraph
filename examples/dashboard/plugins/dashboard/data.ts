import { Schema, Struct } from 'effect';

export const sources = {
  runs: { series: ['running', 'waiting', 'done', 'stopped'], note: 'Current state by start day' },
  checks: { series: ['pass', 'fail'], note: 'All check attempts by check day' },
  tokens: { series: ['input', 'output'], note: 'Reported usage by event day' },
  cost: { series: ['USD'], note: 'Reported usage by event day' },
  issues: { series: ['comment', 'closed', 'merged'], note: 'Tracker comments, closes and merges by event day' },
} as const;

const DashboardWidget = Schema.Struct({
  title: Schema.String.check(Schema.isNonEmpty()),
  type: Schema.Literals(['counter', 'line', 'bar', 'table']),
  source: Schema.Literals(Object.keys(sources) as (keyof typeof sources)[]),
  days: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 90 })),
  workflow: Schema.optionalKey(Schema.String),
  step: Schema.optionalKey(Schema.String),
});

export const DashboardSettings = Schema.Struct({
  widgets: Schema.Array(
    DashboardWidget.check(
      Schema.makeFilter(widget => widget.source !== 'issues' || (!widget.workflow && !widget.step), {
        message: 'issues widgets take no workflow or step',
      })
    )
  ).check(Schema.isMaxLength(24)),
});

export const DashboardSnapshot = Schema.Struct({
  at: Schema.String,
  widgets: Schema.Array(
    Schema.Struct({
      ...Struct.pick(DashboardWidget.fields, ['title', 'type', 'source']),
      rows: Schema.Array(Schema.Struct({ day: Schema.String, series: Schema.String, value: Schema.Finite })),
      skipped: Schema.Int,
      why: Schema.String,
    })
  ),
});

export const DashboardData = Schema.Array(
  Schema.Union([
    Schema.Struct({ instance: Schema.String, ...DashboardSnapshot.fields }),
    Schema.Struct({ instance: Schema.String, why: Schema.String }),
  ])
);
