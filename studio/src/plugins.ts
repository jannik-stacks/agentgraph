import { useAtomValue } from 'jotai';
import { lazy } from 'react';
import { Effect, Schema } from 'effect';
import { makeLiveJsonAtom } from './state.ts';

export { queryParam, navigateAtom } from './state.ts';
export { Button, Link, Loading, Muted, Select, Field, Fields, Help } from './ui.tsx';
export { ResultTable } from './results/ResultTable.tsx';
export const ResultChart = lazy(() => import('./results/ResultChart.tsx'));

const data = new Map<
  string,
  { schema: Schema.Schema.AnyNoContext; atom: Pick<ReturnType<typeof makeLiveJsonAtom>, 'read' | 'toString'> }
>();

export const usePluginData = <D, I>(name: string, schema: Schema.Schema<D, I>) => {
  let cached = data.get(name);
  if (cached && cached.schema !== schema) throw new Error(`Plugin ${name} needs one shared data schema`);
  if (!cached) {
    cached = {
      schema,
      atom: makeLiveJsonAtom(`/api/plugins/${encodeURIComponent(name)}/data`, value =>
        Effect.runPromise(Schema.decodeUnknown(schema)(value)).catch(() => {
          throw new Error('Invalid plugin data');
        })
      ),
    };
    data.set(name, cached);
  }
  return useAtomValue(cached.atom) as ReturnType<ReturnType<typeof makeLiveJsonAtom<D>>['read']>;
};
