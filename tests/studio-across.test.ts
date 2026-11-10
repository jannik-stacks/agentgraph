import { beforeAll, expect, it } from 'vitest';
import { studioDependency, studioModule } from './studio.ts';

type Atom = object;
type Store = { set: (atom: Atom, value: unknown) => void };
type CreateElement = (type: unknown, props?: object | null, ...children: unknown[]) => unknown;

let html: string;
let renderRuns: (path: string, groups: Record<string, object>, results?: Record<string, object>) => string;
let renderApp: (path: string, runs: Record<string, object | null>) => string;
let makeInstanceHref: (href: string) => string;
const served = (name: string, local = false) => ({ name, title: name, local, problems: [] });
const base = { workflow: 'issue', step: 'merge', tries: 0, rounds: {}, usd: 0, started: '2026-10-25T10:00:00Z' };
const listed = (instance: string, run: object) => ({
  fixture: `${instance}/issue`,
  repo: '',
  labels: {},
  run: { ...base, ...run },
  usd: 0,
  trail: [],
  urls: [],
  checks: [],
  instance,
});
const hrefs = (html: string) =>
  [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map(m => m[1]!.replaceAll('&amp;', '&'));
const done = (instance: string) => ({ value: [listed(instance, { id: 'issue-1', issue: 1, status: 'done' })] });

beforeAll(async () => {
  Object.assign(globalThis, {
    studioServed: [served('live', true), served('bench')],
    studioPages: [
      {
        name: 'count',
        title: 'Count',
        href: '/plugins/count',
        load: async () => ({ default: () => 'the count page' }),
      },
      ...['live', 'bench'].map(instance => ({
        name: 'results',
        title: 'Results',
        href: '/results',
        builtin: true,
        instance,
      })),
    ],
    location: { pathname: '/plugins/count', search: '', origin: 'http://127.0.0.1' },
    requestIdleCallback: () => 0,
  });
  const { createElement } = await studioDependency<{ createElement: CreateElement }>('react');
  const { renderToString } = await studioDependency<{ renderToString: (node: unknown) => string }>('react-dom/server');
  const jotai = await studioDependency<{ createStore: () => Store; Provider: unknown }>('jotai');
  const { App } = await studioModule<{ App: () => unknown }>('App.tsx');
  const { RunsPage } = await studioModule<{ RunsPage: () => unknown }>('runs/RunsPage.tsx');
  const state = await studioModule<{
    makeInstanceHref: typeof makeInstanceHref;
    getRunsAtom: (instance: string) => Atom;
    runResultsAtom: (data: undefined, instance: string) => Atom;
    runAtom: (id: string, data: null, instance: string) => Atom;
    locationAtom: Atom;
  }>('state.ts');
  ({ makeInstanceHref } = state);
  html = renderToString(createElement(jotai.Provider, { store: jotai.createStore() }, createElement(App)));
  const makeStore = (path: string) => {
    const store = jotai.createStore();
    const url = new URL(path, 'http://studio');
    store.set(state.locationAtom, { path: url.pathname, query: url.searchParams });
    return store;
  };
  renderRuns = (path, groups, results = {}) => {
    const store = makeStore(path);
    for (const [name, group] of Object.entries(groups)) store.set(state.getRunsAtom(name), group);
    for (const [name, sheet] of Object.entries(results)) store.set(state.runResultsAtom(undefined, name), sheet);
    return renderToString(createElement(jotai.Provider, { store }, createElement(RunsPage)));
  };
  renderApp = (path, runs) => {
    const store = makeStore(path);
    for (const [name, run] of Object.entries(runs)) store.set(state.runAtom('issue-1', null, name), { value: run });
    return renderToString(createElement(jotai.Provider, { store }, createElement(App)));
  };
});

it('serves a studio page outside every instance, with the Runs of all instances and no instance tabs', () => {
  expect({
    hrefs: hrefs(html),
    found: !html.includes('has no page') && !html.includes('serves no instance'),
    api: makeInstanceHref('/api/plugins/count/data'),
  }).toEqual({ hrefs: ['/runs', '/runs', '/plugins/count'], found: true, api: '/api/plugins/count/data' });
  expect(html).not.toContain('<select');
});

it('lists the same run id of two instances apart, each linked under its own instance', () => {
  const page = renderRuns('/runs', { live: done('live'), bench: done('bench') });
  expect(hrefs(page).filter(href => /runs\/issue-1|graph|instance=/.test(href))).toEqual([
    '/runs?instance=bench',
    '/bench/runs/issue-1',
    '/bench/graph?run=bench%2Fissue%3Aissue-1&step=issue%2Fmerge',
    '/runs?instance=live',
    '/live/runs/issue-1',
    '/live/graph?run=live%2Fissue%3Aissue-1&step=issue%2Fmerge',
  ]);
  expect(page).toMatch(/<option value="" selected="">all instances<\/option><option value="live">live<\/option>/);
});

it('finds who waits on people within each instance, so a run in one never hides a run in another', () => {
  const page = renderRuns('/runs?waiting=you', {
    live: { value: [listed('live', { id: 'router-3', issue: 3, status: 'waiting', reason: 'waiting on triage-3' })] },
    bench: { value: [listed('bench', { id: 'triage-3', issue: 3, status: 'running', by: 'router-3' })] },
  });
  expect({
    count: page.includes('1 needs you'),
    listed: hrefs(page).filter(href => href.includes('/runs/')),
    flags: page.includes('--instance live'),
  }).toEqual({ count: true, listed: ['/live/runs/router-3'], flags: true });
});

it('keeps the runs of an instance that loaded beside why another failed', () => {
  const page = renderRuns('/runs', { live: done('live'), bench: { failure: 'disk gone', retry: () => {} } });
  expect({
    failed: page.includes('Could not read bench. disk gone'),
    retry: page.includes('Retry'),
    listed: hrefs(page).filter(href => href.includes('/runs/')),
  }).toEqual({ failed: true, retry: true, listed: ['/live/runs/issue-1'] });
});

it.each([
  ['/runs?instance=bench&issue=1', ['/bench/runs/issue-1']],
  ['/runs?instance=nope', []],
])('lists only the instance %s names, or says it names none', (path, runs) => {
  const page = renderRuns(path, { live: done('live'), bench: done('bench') });
  expect({
    runs: hrefs(page).filter(href => href.includes('/runs/')),
    unknown: page.includes('names no instance this page lists'),
  }).toEqual({ runs, unknown: !runs.length });
});

const sheet = (instance: string) => ({
  value: {
    fields: [],
    runs: [
      { key: 'issue-1', at: base.started, axes: { instance }, results: { humans: { at: base.started, pass: true } } },
    ],
  },
});

it('links the results of a listed run under its own instance', () => {
  const page = renderRuns('/runs', { live: done('live') }, { live: sheet('live') });
  expect(hrefs(page).filter(href => href.includes('results'))).toEqual(['/live/results?run=issue-1']);
});

it.each([
  ['/results?run=issue-1', 'needs an instance', ['/live/results?run=issue-1']],
  ['/runs/issue-1', 'needs an instance', ['/live/runs/issue-1']],
  ['/nope/graph', 'serves no instance named nope', ['/live/graph', '/bench/graph']],
])('answers %s, which no page serves here, with where it does exist', (path, why, links) => {
  const page = renderApp(path, { live: listed('live', { id: 'issue-1' }), bench: null });
  expect({
    why: page.includes(why),
    links: hrefs(page).filter(href => !['/runs', '/plugins/count'].includes(href)),
  }).toEqual({
    why: true,
    links,
  });
});
