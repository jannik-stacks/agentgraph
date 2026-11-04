import { Effect, Schema } from 'effect';
import { GraphSettings, type Graph } from './folder.ts';
import type { Workflow } from './workflow.ts';

export const InstanceFile = Schema.Struct({
  checkout: Schema.String,
  repo: Schema.optionalKey(Schema.String),
  graph: Schema.optionalKey(Schema.String),
  base: Schema.String,
  owner: Schema.String,
  tracker: Schema.optionalKey(Schema.String),
  trust: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  env: Schema.optionalKey(Schema.String),
  loop: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.succeed(false))),
  provider: Schema.mutableKey(Schema.optionalKey(Schema.String)),
  readonly: Schema.optionalKey(Schema.Boolean),
  exported: Schema.mutableKey(Schema.Record(Schema.String, Schema.String)),
  image: GraphSettings.fields.image,
  limits: Schema.optionalKey(Schema.Struct({ parallel: Schema.Int.check(Schema.isGreaterThan(0)) })),
});

export const getSettings = (
  graph: Pick<Graph, 'image' | 'limits'>,
  instance: Partial<typeof InstanceFile.Type>,
  workflow: Pick<Workflow, 'base'> | undefined,
  flags: Partial<Pick<Graph, 'repo' | 'trust' | 'image'>> & { parallel?: number; base?: string }
) => ({
  repo: flags.repo ?? instance.repo ?? '',
  trust: flags.trust ?? instance.trust ?? (instance.owner === undefined ? undefined : [instance.owner]),
  image: flags.image ?? instance.image ?? graph.image,
  parallel: flags.parallel ?? instance.limits?.parallel ?? graph.limits.parallel,
  base: flags.base ?? workflow?.base ?? instance.base,
});
