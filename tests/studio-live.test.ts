import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Schema } from 'effect';
import { expect, it, vi } from 'vitest';
import { studioDir, studioModule } from './studio.ts';

const dependency = <T>(name: string): Promise<T> =>
  import(pathToFileURL(createRequire(join(studioDir, 'package.json')).resolve(name)).href);

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
    await vi.waitFor(() => expect(store.get(plugin)).toEqual({ value: 9, failure: 'Invalid plugin data' }));
    renderToString(createElement(Provider, { store: observed }, createElement(SnapshotProbe, null)));
    expect(used).toBe(plugin);
    readChanged(['count']);
    requests[6]!(Response.json({ error: 'disk gone' }, { status: 500 }));
    await vi.waitFor(() => expect(store.get(plugin)).toEqual({ value: 9, failure: 'disk gone' }));
    stop();
    other();
    readChanged(['count', 'other']);
    expect(requests).toHaveLength(7);
  } finally {
    stop?.();
    other?.();
    vi.unstubAllGlobals();
  }
});
