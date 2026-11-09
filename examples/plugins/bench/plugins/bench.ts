import { isAbsolute, join } from 'node:path';
import { Effect, Schema } from 'effect';
import { makePlugin } from '@jannik-stacks/agi/plugins';
import type { InstanceHosts } from '@jannik-stacks/agi/trackers';
import { makeEngineHost } from '../../../../src/engine.ts';
import { readRealPath } from '../../../../src/instance.ts';
import { findCheckFields, mergeCheckFields } from '../../../../src/results.ts';
import { readBenchRows } from '../../../../bench/runs.ts';
import { BenchData } from './bench/data.ts';

const BenchSettings = Schema.Struct({
  sets: Schema.Array(Schema.String.check(Schema.makeFilter(isAbsolute, { message: 'set paths are absolute' }))).pipe(
    Schema.withDecodingDefault(Effect.succeed([]))
  ),
});

const makeBenchHost = ({ sets }: typeof BenchSettings.Type, hosts: InstanceHosts) => {
  const seen = new Set<string>();
  return makeEngineHost(
    'bench',
    [
      ...Object.entries(hosts).flatMap(([name, host]) =>
        'why' in host ? [] : [{ name, data: host.data, instance: name, ...(host.checks && { checks: host.checks }) }]
      ),
      ...sets.map(set => ({ name: set, data: join(set, 'data') })),
    ].filter(({ data }) => !seen.has(readRealPath(data)) && !!seen.add(readRealPath(data)))
  );
};

const readBenchData = (host: ReturnType<typeof makeBenchHost>): BenchData => {
  const rows = readBenchRows(host);
  return {
    rows,
    ...mergeCheckFields(
      host.configs.map(c =>
        findCheckFields(
          rows.filter(row => row.data === c.data),
          c.checks
        )
      )
    ),
  };
};

export default makePlugin({
  name: 'bench',
  settingsSchema: BenchSettings,
  studio: {
    title: 'Bench',
    page: new URL('./bench/BenchPage.tsx', import.meta.url),
    dataSchema: BenchData,
    watch: (settings, hosts: InstanceHosts) => makeBenchHost(settings, hosts).configs.map(c => c.data),
    read: (settings, hosts) => Effect.sync(() => readBenchData(makeBenchHost(settings, hosts))),
  },
});
