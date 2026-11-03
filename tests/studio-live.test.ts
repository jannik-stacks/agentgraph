import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Schema } from 'effect';
import { expect, it, vi } from 'vitest';
import { studioDir, studioModule } from './studio.ts';

const dependency = <T>(name: string): Promise<T> =>
  import(pathToFileURL(createRequire(join(studioDir, 'package.json')).resolve(name)).href);

it('decodes cached plugin snapshots with one stream, one request in flight and one trailing refetch', async () => {
  vi.stubGlobal('location', new URL('http://studio/plugins/count'));
  const sources: EventTarget[] = [];
  const close = vi.fn();
  vi.stubGlobal(
    'EventSource',
    class extends EventTarget {
      constructor() {
        super();
        sources.push(this);
      }
      close = close;
    }
  );
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
    const { makeLiveJsonAtom } = await studioModule<{ makeLiveJsonAtom: (path: string) => object }>('state.ts');
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
    other = store.sub(makeLiveJsonAtom('/other'), () => {});
    expect(requests).toHaveLength(2);
    expect(sources).toHaveLength(1);
    requests[0]!(Response.json('7'));
    requests[1]!(Response.json(1));
    await vi.waitFor(() => expect(store.get(plugin)).toEqual({ value: 7 }));
    sources[0]!.dispatchEvent(new Event('open'));
    sources[0]!.dispatchEvent(new Event('message'));
    sources[0]!.dispatchEvent(new Event('message'));
    expect(requests).toHaveLength(4);
    requests[2]!(Response.json('8'));
    await vi.waitFor(() => expect(requests).toHaveLength(5));
    expect(store.get(plugin)).toEqual({ value: 8 });
    requests[4]!(Response.json('9'));
    await vi.waitFor(() => expect(store.get(plugin)).toEqual({ value: 9 }));
    await new Promise(resolve => setTimeout(resolve));
    expect(requests).toHaveLength(5);
    sources[0]!.dispatchEvent(new Event('message'));
    expect(requests).toHaveLength(6);
    requests[5]!(Response.json('invalid'));
    await vi.waitFor(() => expect(store.get(plugin)).toEqual({ value: 9, failure: 'Invalid plugin data' }));
    renderToString(createElement(Provider, { store: observed }, createElement(SnapshotProbe, null)));
    expect(used).toBe(plugin);
    stop();
    expect(close).not.toHaveBeenCalled();
    other();
    expect(close).toHaveBeenCalledOnce();
  } finally {
    stop?.();
    other?.();
    vi.unstubAllGlobals();
  }
});
