import { beforeAll, expect, it } from 'vitest';
import { studioDependency, studioModule } from './studio.ts';

type Atom = object;
type Store = { get: (atom: Atom) => unknown; set: (atom: Atom, value: unknown) => void };
type CreateElement = (type: unknown, props?: object | null, ...children: unknown[]) => unknown;

let html: string;
let state: {
  pageAtom: Atom;
  readChanged: (topics: string[]) => void;
  makeLiveJsonAtom: (path: string, topics: string[], read?: undefined, instance?: string) => Atom;
};
const fetched: string[] = [];
const served = (name: string) => ({ name, title: name, local: false, problems: [] });
const asked = (instance = 'bench') => fetched.filter(url => url === `/api/topic?instance=${instance}`).length;

beforeAll(async () => {
  Object.assign(globalThis, {
    studioServed: [served('live'), served('bench')],
    location: { pathname: '/bench/runs/run-1', search: '', origin: 'http://127.0.0.1' },
    requestIdleCallback: () => 0,
    fetch: (url: string) => {
      fetched.push(url);
      return Promise.resolve({ ok: true, json: async () => [] });
    },
  });
  const { createElement } = await studioDependency<{ createElement: CreateElement }>('react');
  const { renderToString } = await studioDependency<{ renderToString: (node: unknown) => string }>('react-dom/server');
  const jotai = await studioDependency<{ createStore: () => Store; Provider: unknown }>('jotai');
  const { App } = await studioModule<{ App: () => unknown }>('App.tsx');
  state = await studioModule('state.ts');
  html = renderToString(createElement(jotai.Provider, { store: jotai.createStore() }, createElement(App)));
});

it('reads the instance from the first path segment and keeps every in-app link under it', () => {
  const hrefs = [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map(m => m[1]);
  expect(hrefs).toContain('/bench/runs');
  expect(hrefs).toContain('/bench/graph');
  expect(hrefs.filter(href => href?.startsWith('/') && !href.startsWith('/bench/'))).toEqual([
    '/runs',
    '/plugins/count',
  ]);
  expect(html).not.toContain('<select');
});

it('asks the API for the shown instance and follows only its change topics', async () => {
  const jotai = await studioDependency<{
    createStore: () => Store & { sub: (atom: Atom, f: () => void) => () => void };
  }>('jotai');
  const store = jotai.createStore();
  expect(store.get(state.pageAtom)).toEqual({ route: 'runs', id: 'run-1' });
  store.sub(state.makeLiveJsonAtom('/api/topic', ['data']), () => {});
  expect(asked()).toBe(1);
  await new Promise(resolve => setTimeout(resolve));
  state.readChanged(['live:data', 'graph:data']);
  expect(asked()).toBe(1);
  state.readChanged(['bench:data']);
  expect(asked()).toBe(2);
});

it('asks for and follows another instance when an atom names it', async () => {
  const jotai = await studioDependency<{
    createStore: () => Store & { sub: (atom: Atom, f: () => void) => () => void };
  }>('jotai');
  jotai.createStore().sub(state.makeLiveJsonAtom('/api/topic', ['data'], undefined, 'live'), () => {});
  await new Promise(resolve => setTimeout(resolve));
  const counts = [asked('live')];
  state.readChanged(['bench:data']);
  counts.push(asked('live'));
  state.readChanged(['live:data']);
  counts.push(asked('live'));
  expect(counts).toEqual([1, 1, 2]);
});
