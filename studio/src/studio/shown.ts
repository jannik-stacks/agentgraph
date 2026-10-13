import { atom, useAtomValue } from 'jotai';
import { type GraphModel, type Layer, layerModel } from '../graph-model.ts';
import { collapse } from './collapse.ts';

const layerKey = 'bhm.studio.layer';

const loadLayer = (): Layer => {
  try {
    return localStorage.getItem(layerKey) === 'cast' ? 'cast' : 'flow';
  } catch {
    return 'flow';
  }
};

const storedLayer = atom<Layer>(loadLayer());

/** The layer the graph draws, remembered per browser. */
export const layerAtom = atom(
  get => get(storedLayer),
  (_get, set, next: Layer) => {
    set(storedLayer, next);
    try {
      localStorage.setItem(layerKey, next);
    } catch {}
  }
);

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
