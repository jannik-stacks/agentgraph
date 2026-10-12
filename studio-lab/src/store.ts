import { atom } from 'jotai'
import type { DatasetKey } from './data'

export const variants = ['xyflow-dagre', 'xyflow-elk', 'cytoscape', 'reaflow', 'mermaid'] as const
export type Variant = (typeof variants)[number]

const readHash = () => new URLSearchParams(location.hash.slice(1))

const hashAtom = atom(readHash())
hashAtom.onMount = (set) => {
  const sync = () => set(readHash())
  addEventListener('hashchange', sync)
  return () => removeEventListener('hashchange', sync)
}

function hashParam<T extends string>(key: string, allowed: readonly T[]) {
  return atom(
    (get) => {
      const value = get(hashAtom).get(key) as T | null
      return value && allowed.includes(value) ? value : allowed[0]!
    },
    (get, set, value: T) => {
      const params = new URLSearchParams(get(hashAtom))
      params.set(key, value)
      location.hash = params.toString()
      set(hashAtom, params)
    },
  )
}

export const variantAtom = hashParam('v', variants)
export const datasetAtom = hashParam<DatasetKey>('data', ['small', 'big'])
export const selectedIdAtom = atom<string | null>(null)
