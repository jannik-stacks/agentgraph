import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { studioDir, studioModule } from './studio.ts';

type Atom = object;
type Store = { get: (atom: Atom) => unknown; set: (atom: Atom, value: unknown) => void };
type CreateElement = (type: unknown, props?: object | null, ...children: unknown[]) => unknown;

const studioRequire = createRequire(join(studioDir, 'package.json'));
const dependency = <T>(name: string) =>
  import(/* @vite-ignore */ pathToFileURL(studioRequire.resolve(name)).href) as Promise<T>;

let render: (path: string) => string;
let renderInbox: (runs: object[]) => string;
let renderPicker: (keys: string[], hidden: string[]) => string;
let makeStore: () => Store;
let makeHiddenKeysAtom: (name: string) => Atom;
const stored = new Map<string, string>();
const routes = ['inbox', 'graph', 'runs', 'plugins/count', 'docs'];

beforeAll(async () => {
  Object.assign(globalThis, {
    location: { pathname: '/', search: '', origin: 'http://127.0.0.1' },
    requestIdleCallback: () => 0,
    localStorage: {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => stored.set(k, v),
    },
  });
  const { createElement } = await dependency<{ createElement: CreateElement }>('react');
  const { renderToString } = await dependency<{ renderToString: (node: unknown) => string }>('react-dom/server');
  const jotai = await dependency<{ createStore: () => Store; Provider: unknown }>('jotai');
  const { App } = await studioModule<{ App: () => unknown }>('App.tsx');
  const state = await studioModule<{ locationAtom: Atom }>('state.ts');
  render = path => {
    const store = jotai.createStore();
    store.set(state.locationAtom, { path, query: new URLSearchParams() });
    return renderToString(createElement(jotai.Provider, { store }, createElement(App)));
  };
  const { InboxPage } = await studioModule<{ InboxPage: () => unknown }>('runs/InboxPage.tsx');
  const { runsAtom } = await studioModule<{ runsAtom: Atom }>('state.ts');
  renderInbox = runs => {
    const store = jotai.createStore();
    store.set(runsAtom, { value: runs.map(run => ({ fixture: '', repo: '', labels: {}, run, trace: [] })) });
    return renderToString(createElement(jotai.Provider, { store }, createElement(InboxPage)));
  };
  const ui = await studioModule<{ KeyPicker: unknown; makeHiddenKeysAtom: (name: string) => Atom }>('ui.tsx');
  renderPicker = (keys, hidden) =>
    renderToString(createElement(ui.KeyPicker, { label: 'Labels', keys, hidden, onChange: () => {} }));
  makeHiddenKeysAtom = ui.makeHiddenKeysAtom;
  makeStore = jotai.createStore;
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
  it('links every route from the header in order, plugin pages before docs, and marks the one shown', () => {
    for (const route of routes) {
      const [header = ''] = navs(render(`/${route}`));
      expect(links(header)).toEqual(routes.map(other => ({ href: `/${other}`, current: other === route })));
    }
  });

  it('links a declared plugin page and marks its route', () => {
    expect(links(navs(render('/plugins/count'))[0]!)).toContainEqual({ href: '/plugins/count', current: true });
    expect(render('/plugins/count')).not.toContain('Page not found.');
  });

  it.each(['constructor', 'toString', '__proto__', 'missing'])('shows an unknown plugin page: %s', name => {
    expect(render(`/plugins/${name}`)).toContain('Page not found.');
  });

  it('lists the runs that wait on a person with what to do, and not those that wait on another run', () => {
    const base = { workflow: 'issue', step: 'merge', tries: 0, rounds: {}, usd: 0, started: '2026-10-25T10:00:00Z' };
    expect(renderInbox([{ ...base, id: 'done-1', issue: 1, status: 'done' }])).toContain('Nothing waits for you.');
    const html = renderInbox([
      { ...base, id: 'issue-2', issue: 2, status: 'waiting' },
      { ...base, id: 'router-3', issue: 3, status: 'waiting', reason: 'waiting on triage-3' },
      { ...base, id: 'triage-3', issue: 3, status: 'running', by: 'router-3' },
      { ...base, id: 'router-4', issue: 4, status: 'waiting', reason: 'Hello or hi?' },
    ]);
    expect(html).toContain('Review the PR linked from');
    expect(html).toContain('Hello or hi?');
    expect(html).toContain('/runs/issue-2');
    expect(html).not.toContain('/runs/router-3');
  });

  it('offers every label key and marks the hidden ones unpressed', () => {
    const html = renderPicker(['arm', 'case', 'set'], ['arm']);
    expect([...html.matchAll(/aria-pressed="(\w+)"[^>]*>(\w+)</g)].map(m => [m[2], m[1]])).toEqual([
      ['arm', 'false'],
      ['case', 'true'],
      ['set', 'true'],
    ]);
  });

  it('keeps hidden keys when this browser stores them, and none when storage throws', () => {
    const kept = makeHiddenKeysAtom('test.kept');
    const store = makeStore();
    store.set(kept, ['arm']);
    expect(stored.get('test.kept')).toBe('["arm"]');
    expect(store.get(makeHiddenKeysAtom('test.kept'))).toEqual(['arm']);
    const was = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('blocked');
      },
    });
    try {
      const blocked = makeHiddenKeysAtom('test.blocked');
      const other = makeStore();
      expect(other.get(blocked)).toEqual([]);
      other.set(blocked, ['case']);
      expect(other.get(blocked)).toEqual(['case']);
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: was });
    }
  });
});
