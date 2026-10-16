import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { studioDir, studioModule } from './studio.ts';

type Atom = object;
type Store = { set: (atom: Atom, value: unknown) => void };
type CreateElement = (type: unknown, props?: object | null, ...children: unknown[]) => unknown;

const studioRequire = createRequire(join(studioDir, 'package.json'));
const dependency = <T>(name: string) =>
  import(/* @vite-ignore */ pathToFileURL(studioRequire.resolve(name)).href) as Promise<T>;

let render: (path: string) => string;
let routes: readonly string[];

beforeAll(async () => {
  Object.assign(globalThis, {
    location: { pathname: '/', search: '', origin: 'http://127.0.0.1' },
    requestIdleCallback: () => 0,
  });
  const { createElement } = await dependency<{ createElement: CreateElement }>('react');
  const { renderToString } = await dependency<{ renderToString: (node: unknown) => string }>('react-dom/server');
  const jotai = await dependency<{ createStore: () => Store; Provider: unknown }>('jotai');
  const { App } = await studioModule<{ App: () => unknown }>('App.tsx');
  const state = await studioModule<{ locationAtom: Atom; routes: readonly string[] }>('state.ts');
  routes = state.routes;
  render = path => {
    const store = jotai.createStore();
    store.set(state.locationAtom, { path, query: new URLSearchParams() });
    return renderToString(createElement(jotai.Provider, { store }, createElement(App)));
  };
  render('/runs');
  await new Promise(resolve => setTimeout(resolve));
});

/** The `href` of every link in the HTML, with whether it is marked as the current page. */
const links = (html: string) =>
  [...html.matchAll(/<a\b([^>]*)>/g)].map(m => ({
    href: /\bhref="([^"]*)"/.exec(m[1]!)?.[1],
    current: /\baria-current="page"/.test(m[1]!),
  }));

/** The HTML of each `<nav>`, in document order. */
const navs = (html: string) => [...html.matchAll(/<nav\b[\s\S]*?<\/nav>/g)].map(m => m[0]);

describe('studio navigation', () => {
  it('links every route from the header, and marks the one shown', () => {
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      const [header = ''] = navs(render(`/${route}`));
      const found = links(header);
      for (const other of routes) expect(found).toContainEqual({ href: `/${other}`, current: other === route });
    }
  });
});
