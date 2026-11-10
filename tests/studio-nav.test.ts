import { beforeAll, describe, expect, it } from 'vitest';
import { studioDependency, studioModule } from './studio.ts';

type Atom = object;
type Store = { get: (atom: Atom) => unknown; set: (atom: Atom, value: unknown) => void };
type CreateElement = (type: unknown, props?: object | null, ...children: unknown[]) => unknown;

let render: (path: string) => string;
let renderRuns: (runs: object[], path: string) => string;
let renderPicker: (keys: string[], hidden: string[]) => string;
let makeStore: () => Store;
let makeHiddenKeysAtom: (name: string) => Atom;
const stored = new Map<string, string>();
const official = ['graph', 'runs', 'docs'];
const routes = [...official, 'plugins/count'];

beforeAll(async () => {
  Object.assign(globalThis, {
    location: { pathname: '/', search: '', origin: 'http://127.0.0.1' },
    requestIdleCallback: () => 0,
    localStorage: {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => stored.set(k, v),
    },
  });
  const { createElement } = await studioDependency<{ createElement: CreateElement }>('react');
  const { renderToString } = await studioDependency<{ renderToString: (node: unknown) => string }>('react-dom/server');
  const jotai = await studioDependency<{ createStore: () => Store; Provider: unknown }>('jotai');
  const { App } = await studioModule<{ App: () => unknown }>('App.tsx');
  const state = await studioModule<{ locationAtom: Atom; getRunsAtom: () => Atom }>('state.ts');
  render = path => {
    const store = jotai.createStore();
    store.set(state.locationAtom, { path, query: new URLSearchParams() });
    return renderToString(createElement(jotai.Provider, { store }, createElement(App)));
  };
  const { RunsPage } = await studioModule<{ RunsPage: () => unknown }>('runs/RunsPage.tsx');
  renderRuns = (runs, path) => {
    const store = jotai.createStore();
    const url = new URL(path, 'http://studio');
    store.set(state.locationAtom, { path: url.pathname, query: url.searchParams });
    store.set(state.getRunsAtom(), {
      value: runs.map(run => ({ fixture: '', repo: '', labels: {}, run, usd: 0, trail: [], urls: [], checks: [] })),
    });
    return renderToString(createElement(jotai.Provider, { store }, createElement(RunsPage)));
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
  it.each(routes)('links official pages, then plugin pages in their own group, marking %s', route => {
    expect(navs(render(`/${route}`)).map(links)).toEqual(
      [official, ['plugins/count']].map(group => group.map(other => ({ href: `/${other}`, current: other === route })))
    );
  });

  it('shows a declared plugin page once its module loads', async () => {
    render('/plugins/count');
    await new Promise(resolve => setTimeout(resolve));
    expect(render('/plugins/count')).toContain('the count page');
  });

  it.each(['constructor', 'toString', '__proto__', 'missing'])('shows an unknown plugin page: %s', name => {
    expect(render(`/plugins/${name}`)).toContain(`This studio has no page at /plugins/${name}.`);
  });

  it('filters the runs to those that wait on a person, with what to do, and not those that wait on another run', () => {
    const base = { workflow: 'issue', step: 'merge', tries: 0, rounds: {}, usd: 0, started: '2026-10-25T10:00:00Z' };
    const done = { ...base, id: 'done-1', issue: 1, status: 'done' };
    expect(renderRuns([done], '/runs?waiting=you')).toContain('Nothing waits for you.');
    expect(renderRuns([done], '/runs')).not.toContain('need');
    const html = renderRuns(
      [
        { ...base, id: 'issue-2', issue: 2, status: 'waiting' },
        { ...base, id: 'router-3', issue: 3, status: 'waiting', waiting: { on: 'run', id: 'triage-3' } },
        { ...base, id: 'triage-3', issue: 3, status: 'running', by: 'router-3' },
        { ...base, id: 'router-4', issue: 4, status: 'waiting', reason: 'Hello or hi?' },
        done,
      ],
      '/runs?waiting=you'
    );
    expect(html).toContain('2 need you');
    expect(html).not.toContain('/runs/done-1');
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
