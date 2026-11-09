import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Schema } from 'effect';
import { expect, it, vi } from 'vitest';
import { studioDir, studioModule } from './studio.ts';

const dependency = <T>(name: string): Promise<T> =>
  import(pathToFileURL(createRequire(join(studioDir, 'package.json')).resolve(name)).href);

const answerAction = (exit: object) => async (_: unknown, init?: RequestInit) => {
  const { id } = JSON.parse(new TextDecoder().decode(init!.body as Uint8Array)) as { id: string };
  return new Response(`${JSON.stringify({ _tag: 'Exit', requestId: id, exit })}\n`);
};

it('decodes cached plugin snapshots, refetching on its topic with one request in flight and one trailing', async () => {
  vi.stubGlobal('location', new URL('http://studio/plugins/count'));
  const requests: ((response: Response) => void)[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(resolve => requests.push(resolve)))
  );
  let stop: (() => void) | undefined;
  let other: (() => void) | undefined;
  try {
    const { createElement } = await dependency<{
      createElement: (type: unknown, props: object | null, ...children: unknown[]) => unknown;
    }>('react');
    const { renderToString } = await dependency<{ renderToString: (value: unknown) => string }>('react-dom/server');
    const { createStore, Provider } = await dependency<{
      createStore: () => {
        get: (atom: object) => unknown;
        sub: (atom: object, listener: () => void) => () => void;
      };
      Provider: unknown;
    }>('jotai');
    const { usePluginData } = await studioModule<{ usePluginData: (name: string, schema: unknown) => unknown }>(
      'plugins.ts'
    );
    const { makeLiveJsonAtom, readChanged } = await studioModule<{
      makeLiveJsonAtom: (path: string, topics: string[]) => object;
      readChanged: (topics: string[]) => void;
    }>('state.ts');
    const store = createStore();
    let used: object = {};
    const observed = {
      ...store,
      get: (atom: object) => {
        used = atom;
        return store.get(atom);
      },
    };
    const SnapshotProbe = () => {
      usePluginData('count', Schema.FiniteFromString);
      return null;
    };
    renderToString(createElement(Provider, { store: observed }, createElement(SnapshotProbe, null)));
    const plugin = used;
    stop = store.sub(plugin, () => {});
    other = store.sub(makeLiveJsonAtom('/other', ['other']), () => {});
    expect(requests).toHaveLength(2);
    requests[0]!(Response.json('7'));
    requests[1]!(Response.json(1));
    await vi.waitFor(() => expect(store.get(plugin)).toEqual({ value: 7 }));
    readChanged(['count']);
    readChanged(['count', 'data']);
    expect(requests).toHaveLength(3);
    requests[2]!(Response.json('8'));
    await vi.waitFor(() => expect(requests).toHaveLength(4));
    expect(store.get(plugin)).toEqual({ value: 8 });
    requests[3]!(Response.json('9'));
    await vi.waitFor(() => expect(store.get(plugin)).toEqual({ value: 9 }));
    await new Promise(resolve => setTimeout(resolve));
    expect(requests).toHaveLength(4);
    readChanged(['data']);
    expect(requests).toHaveLength(4);
    readChanged(['other']);
    expect(requests).toHaveLength(5);
    requests[4]!(Response.json(2));
    readChanged(['count']);
    expect(requests).toHaveLength(6);
    requests[5]!(Response.json('invalid'));
    await vi.waitFor(() => expect(store.get(plugin)).toMatchObject({ value: 9, failure: 'Invalid plugin data' }));
    renderToString(createElement(Provider, { store: observed }, createElement(SnapshotProbe, null)));
    expect(used).toBe(plugin);
    (store.get(plugin) as { retry: () => void }).retry();
    requests[6]!(Response.json({ error: 'disk gone' }, { status: 500 }));
    await vi.waitFor(() => expect(store.get(plugin)).toMatchObject({ value: 9, failure: 'disk gone' }));
    readChanged(['count']);
    requests[7]!(Response.json('10'));
    await vi.waitFor(() => expect(store.get(plugin)).toEqual({ value: 10 }));
    stop();
    other();
    readChanged(['count', 'other']);
    expect(requests).toHaveLength(8);
  } finally {
    stop?.();
    other?.();
    vi.unstubAllGlobals();
  }
});

it('shows loading, a failure with retry, and stale data under one refresh note', async () => {
  const { createElement } = await dependency<{
    createElement: (type: unknown, props: object | null, ...children: unknown[]) => unknown;
  }>('react');
  const { renderToStaticMarkup } = await dependency<{ renderToStaticMarkup: (value: unknown) => string }>(
    'react-dom/server'
  );
  const { Live } = await studioModule<{ Live: unknown }>('ui.tsx');
  const show = (state: object) =>
    renderToStaticMarkup(createElement(Live, { state, children: (value: string) => `shown ${value}` }));
  expect(show({})).toContain('aria-label="Loading"');
  expect(show({ failure: 'disk gone', retry: () => {} })).toMatch(/disk gone.*Retry/);
  const stale = show({ value: 'old', failure: 'disk gone' });
  expect(stale).toContain('Could not refresh, showing earlier data. disk gone');
  expect(stale).toContain('shown old');
  expect(show({ value: 'new' })).toBe('shown new');
});

it('keeps every opened run atom while it is subscribed, past any number of runs', async () => {
  vi.stubGlobal('location', new URL('http://studio/runs'));
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => {}))
  );
  const { createStore } = await dependency<{
    createStore: () => { sub: (atom: object, listener: () => void) => () => void };
  }>('jotai');
  const { runAtom, runResultsAtom } = await studioModule<{
    runAtom: (id: string) => object;
    runResultsAtom: () => object;
  }>('state.ts');
  const store = createStore();
  const ids = Array.from({ length: 150 }, (_, i) => `kept-${i}`);
  const first = runAtom(ids[0]!);
  const stops = [...ids.map(id => store.sub(runAtom(id), () => {})), store.sub(runResultsAtom(), () => {})];
  try {
    expect(runAtom(ids[0]!)).toBe(first);
    expect(new Set(ids.map(id => runAtom(id))).size).toBe(ids.length);
  } finally {
    for (const stop of stops) stop();
    vi.unstubAllGlobals();
  }
});

it('reads a run the server answers 404 and null for as gone, not as a failure', async () => {
  vi.stubGlobal('location', new URL('http://studio/runs'));
  vi.stubGlobal('fetch', vi.fn(answerAction({ _tag: 'Success', value: null })));
  const { createStore } = await dependency<{
    createStore: () => { get: (atom: object) => unknown; sub: (atom: object, listener: () => void) => () => void };
  }>('jotai');
  const { runAtom } = await studioModule<{ runAtom: (id: string) => object }>('state.ts');
  const store = createStore();
  const gone = runAtom('gone');
  const stop = store.sub(gone, () => {});
  try {
    await vi.waitFor(() => expect(store.get(gone)).toEqual({ value: null }));
  } finally {
    stop();
    vi.unstubAllGlobals();
  }
});

it('fails on a broken body or an empty error, keeping the earlier snapshot, and reads every atom on connect', async () => {
  vi.stubGlobal('location', new URL('http://studio/runs'));
  const answers: Response[] = [
    new Response('[1', { status: 200 }),
    Response.json(['old']),
    new Response('[1', { status: 200 }),
    Response.json({ error: '' }, { status: 500 }),
    Response.json(['new']),
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => answers.shift()!)
  );
  const { createStore } = await dependency<{
    createStore: () => { get: (atom: object) => unknown; sub: (atom: object, listener: () => void) => () => void };
  }>('jotai');
  const { makeLiveJsonAtom, readChanged } = await studioModule<{
    makeLiveJsonAtom: (path: string, topics: string[]) => object;
    readChanged: (topics?: string[]) => void;
  }>('state.ts');
  const store = createStore();
  const list = makeLiveJsonAtom('/list', ['data']);
  const stop = store.sub(list, () => {});
  const state = () => store.get(list) as { value?: unknown; failure?: string; retry?: () => void };
  try {
    await vi.waitFor(() => expect(state().failure).toBeTypeOf('string'));
    expect(state().value).toBeUndefined();
    state().retry!();
    await vi.waitFor(() => expect(state()).toEqual({ value: ['old'] }));
    readChanged(['data']);
    await vi.waitFor(() => expect(state().failure).toBeTypeOf('string'));
    expect(state().value).toEqual(['old']);
    readChanged(['data']);
    await vi.waitFor(() => expect(state().failure).toBe('/list answered 500'));
    expect(state().value).toEqual(['old']);
    readChanged();
    await vi.waitFor(() => expect(state()).toEqual({ value: ['new'] }));
  } finally {
    stop();
    vi.unstubAllGlobals();
  }
});

it('shows an empty failure as a failure', async () => {
  const { createElement } = await dependency<{
    createElement: (type: unknown, props: object | null, ...children: unknown[]) => unknown;
  }>('react');
  const { renderToStaticMarkup } = await dependency<{ renderToStaticMarkup: (value: unknown) => string }>(
    'react-dom/server'
  );
  const { Live } = await studioModule<{ Live: unknown }>('ui.tsx');
  const show = (state: object) =>
    renderToStaticMarkup(createElement(Live, { state, children: (value: string) => `shown ${value}` }));
  expect(show({ failure: '', retry: () => {} })).toContain('Retry');
  expect(show({ value: 'old', failure: '' })).toContain('Could not refresh, showing earlier data.');
});

it('keeps a check panel verdicts shown under a refresh note when a refresh fails', async () => {
  vi.stubGlobal('location', new URL('http://studio/graph'));
  const verdict = { run: 'r1', issue: 7, at: '2026-11-01T10:00:00Z', pass: false, empty: false, items: 0, failed: 0 };
  const answers = [
    answerAction({ _tag: 'Success', value: [verdict] }),
    answerAction({
      _tag: 'Failure',
      cause: [{ _tag: 'Fail', error: { _tag: 'ActionError', message: 'checks unreadable' } }],
    }),
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => answers.shift()!(input, init))
  );
  const { createElement } = await dependency<{
    createElement: (type: unknown, props: object | null, ...children: unknown[]) => unknown;
  }>('react');
  const { renderToStaticMarkup } = await dependency<{ renderToStaticMarkup: (value: unknown) => string }>(
    'react-dom/server'
  );
  const { createStore, Provider } = await dependency<{
    createStore: () => { get: (atom: object) => unknown; sub: (atom: object, listener: () => void) => () => void };
    Provider: unknown;
  }>('jotai');
  const { getVerdictsAtom, readChanged, shown } = await studioModule<{
    getVerdictsAtom: (fixture: string, step: string, check: string) => object;
    readChanged: (topics?: string[]) => void;
    shown?: { title: string };
  }>('state.ts');
  const id = `${shown?.title}/issue`;
  const { CheckDetails } = await studioModule<{ CheckDetails: unknown }>('graph/OpenedDetails.tsx');
  const store = createStore();
  const verdicts = getVerdictsAtom(id, 'implement', 'review');
  const stop = store.sub(verdicts, () => {});
  const show = () =>
    renderToStaticMarkup(
      createElement(
        Provider,
        { store },
        createElement(CheckDetails, {
          fixture: { id, checks: { review: { mode: 'block' } }, agents: {} },
          path: 'issue/implement',
          name: 'review',
        })
      )
    );
  try {
    await vi.waitFor(() => expect(store.get(verdicts)).toEqual({ value: [verdict] }));
    expect(show()).toContain('Ran 1 time, failed 1, skipped 0.');
    readChanged(['data']);
    await vi.waitFor(() => expect(store.get(verdicts)).toMatchObject({ failure: 'checks unreadable' }));
    const stale = show();
    expect(stale).toContain('Could not refresh, showing earlier data. checks unreadable');
    expect(stale).toContain('Ran 1 time, failed 1, skipped 0.');
  } finally {
    stop();
    vi.unstubAllGlobals();
  }
});
