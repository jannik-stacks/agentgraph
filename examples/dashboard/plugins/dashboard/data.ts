import { Schema } from 'effect';

export const DashboardSettings = Schema.Struct({
  widgets: Schema.Array(
    Schema.Struct({
      title: Schema.String.check(Schema.isNonEmpty()),
      type: Schema.Literals(['counter', 'line', 'bar', 'table']),
      source: Schema.Literals(['runs', 'checks', 'tokens', 'cost', 'issues']),
      days: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 90 })),
      workflow: Schema.optionalKey(Schema.String),
      step: Schema.optionalKey(Schema.String),
    }).check(
      Schema.makeFilter(widget => widget.source !== 'issues' || (!widget.workflow && !widget.step), {
        message: 'issues widgets take no workflow or step',
      })
    )
  ).check(Schema.isMaxLength(24)),
});

export const DashboardData = Schema.Struct({
  at: Schema.String,
  widgets: Schema.Array(
    Schema.Struct({
      title: DashboardSettings.fields.widgets.value.fields.title,
      type: DashboardSettings.fields.widgets.value.fields.type,
      source: DashboardSettings.fields.widgets.value.fields.source,
      rows: Schema.Array(Schema.Struct({ day: Schema.String, series: Schema.String, value: Schema.Finite })),
      skipped: Schema.Int,
      why: Schema.String,
    })
  ),
});
