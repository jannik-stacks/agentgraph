import { useAtomValue } from 'jotai';
import { useDeferredValue, useMemo, useRef } from 'react';
import type { Config } from '../../../src/config.ts';
import { type GraphModel, graphModel } from '../graph-model.ts';
import { hubAtom } from '../state.ts';
import { draftHubAtom } from './edit/hub-edits.ts';

/**
 * The hub with its pending edits, as a graph model that changes only when the compiled config does. Keeps the last
 * model that compiled while the edits do not. The items load alongside the compiled hub.
 */
export const useHubModel = () => {
  const draft = useDeferredValue(useAtomValue(draftHubAtom));
  const hub = useAtomValue(hubAtom);
  const config: Config | undefined = draft ? draft.validated.config : 'config' in hub ? hub.config : undefined;
  const key = config ? JSON.stringify(config) : '';
  const model = useMemo(() => (key ? graphModel(JSON.parse(key) as Config) : undefined), [key]);
  const last = useRef<{ config: Config; model: GraphModel } | undefined>(undefined);
  if (model && config) last.current = { config, model };
  const errors = draft ? draft.validated.errors : 'errors' in hub ? hub.errors : [];
  return { model: model ?? last.current?.model, config: config ?? last.current?.config, errors };
};
