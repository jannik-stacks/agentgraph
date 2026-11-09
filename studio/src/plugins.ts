import { useAtomValue } from 'jotai';
import { lazy } from 'react';
import { Effect, Schema } from 'effect';
import type { InstanceHost } from '../../src/engine.ts';
import { makeApiHref, makeLiveJsonAtom } from './state.ts';

export { queryParam, navigateAtom } from './state.ts';
export { Badge, Button, Disclosure, Field, Fields, Help, Link, Live, Loading, Muted, Select, Tooltip } from './ui.tsx';
export { ResultTable } from './results/ResultTable.tsx';
export const ResultChart = lazy(() => import('./results/ResultChart.tsx'));

const data = new Map<
  string,
  { schema: Schema.Codec<unknown, unknown>; atom: Pick<ReturnType<typeof makeLiveJsonAtom>, 'read' | 'toString'> }
>();

export const usePluginData = <D, I>(name: string, schema: Schema.Codec<D, I>) => {
  let cached = data.get(name);
  if (cached && cached.schema !== schema) throw new Error(`Plugin ${name} needs one shared data schema`);
  if (!cached) {
    cached = {
      schema,
      atom: makeLiveJsonAtom(`/api/plugins/${encodeURIComponent(name)}/data`, [name, 'data'], value =>
        Effect.runPromise(Schema.decodeUnknownEffect(schema)(value)).catch(() => {
          throw new Error('Invalid plugin data');
        })
      ),
    };
    data.set(name, cached);
  }
  return useAtomValue(cached.atom) as ReturnType<ReturnType<typeof makeLiveJsonAtom<D>>['read']>;
};

export const runAction = async <V extends 'say' | 'label'>(verb: V, ...args: Parameters<InstanceHost[V]>) => {
  const response = await fetch(makeApiHref(`/api/actions/${verb}`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const body: unknown = await response.json();
  if (!response.ok)
    throw new Error((body as { error?: string } | null)?.error ?? `${verb} answered ${response.status}`);
  return body;
};
