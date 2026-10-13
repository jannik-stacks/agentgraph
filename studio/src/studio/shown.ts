import { useAtomValue } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import { type GraphModel, type Layer, layerModel } from '../graph-model.ts';
import { collapse } from './collapse.ts';

/** The layer the graph draws, remembered per browser. */
export const layerAtom = atomWithStorage<Layer>('bhm.studio.layer', 'flow', undefined, { getOnInit: true });

const cache = new WeakMap<GraphModel, Partial<Record<Layer, GraphModel>>>();

/** The part of the model a layer draws, with crowded groups folded into stacks. */
export const shownModel = (model: GraphModel, layer: Layer) => {
  const byLayer = cache.get(model) ?? {};
  cache.set(model, byLayer);
  return (byLayer[layer] ??= collapse(layerModel(model, layer)));
};

export const useShownModel = (model: GraphModel | undefined) => {
  const layer = useAtomValue(layerAtom);
  return model && shownModel(model, layer);
};
