import { Effect } from 'effect';
import type { EngineHost } from '../../../src/engine.ts';
import { makePlugin } from '../../../src/plugin.ts';
import { findCheckFields, mergeCheckFields } from '../../../src/results.ts';
import { BenchData } from './data.ts';
import { readBenchRows } from '../../../bench/runs.ts';

const readBenchData = (host: EngineHost): BenchData => {
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
  engine: (host: EngineHost) => ({ read: () => readBenchData(host), roots: host.configs.map(c => c.data) }),
  studio: {
    title: 'Bench',
    page: new URL('./BenchPage.tsx', import.meta.url),
    dataSchema: BenchData,
    watch: (_settings, bench) => bench.roots,
    read: (_settings, bench) => Effect.sync(bench.read),
  },
});
