import { isAbsolute } from 'node:path';
import { Effect, Schema } from 'effect';
import { makePlugin } from '@jannik-stacks/agi/plugins';
import { makeSetHost, readBenchData } from '../../../../bench/runs.ts';
import { BenchData } from './bench/data.ts';

export default makePlugin({
  name: 'bench',
  settingsSchema: Schema.Struct({
    sets: Schema.Array(Schema.String.check(Schema.makeFilter(isAbsolute, { message: 'set paths are absolute' }))).pipe(
      Schema.withDecodingDefault(Effect.succeed([]))
    ),
  }),
  studio: {
    title: 'Bench',
    page: new URL('./bench/BenchPage.tsx', import.meta.url),
    dataSchema: BenchData,
    watch: ({ sets }, hosts) => makeSetHost(sets, hosts).configs.map(c => c.data),
    read: ({ sets }, hosts) => Effect.sync(() => readBenchData(makeSetHost(sets, hosts))),
  },
});
