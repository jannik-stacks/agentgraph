import { Schema } from 'effect';

export const DashboardSettings = Schema.Struct({
  data: Schema.String.check(Schema.isNonEmpty()),
  widgets: Schema.Array(
    Schema.Struct({
      title: Schema.String.check(Schema.isNonEmpty()),
      type: Schema.Literals(['counter', 'line', 'bar', 'table']),
      source: Schema.Literals(['runs', 'checks', 'tokens', 'cost']),
      days: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 90 })),
      workflow: Schema.optionalKey(Schema.String),
      step: Schema.optionalKey(Schema.String),
    })
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
