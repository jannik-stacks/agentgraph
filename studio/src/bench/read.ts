import type * as RunsModule from '../../../bench/runs.ts';
import type { BenchData } from './data.ts';

export const readBench = async (dirs: string[]): Promise<BenchData> => {
  const { readBenchRows }: typeof RunsModule = await import(new URL('../../../bench/runs.ts', import.meta.url).href);
  return { rows: readBenchRows(dirs) };
};
