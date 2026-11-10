import { afterAll, expect, it, vi } from 'vitest';
import { studioDependency, studioModule } from './studio.ts';

type Atom = object;
type Store = { get: (atom: Atom) => unknown; sub: (atom: Atom, listener: () => void) => () => void };
type CreateElement = (type: unknown, props?: object | null, ...children: unknown[]) => unknown;

const served = (name: string) => ({ name, title: name, local: false, problems: [] });
const run = {
  fixture: 'live/issue',
  repo: 'o/r',
  labels: {},
  trace: [],
  usd: 0,
  trail: [],
  urls: [],
  run: { id: 'run-1', workflow: 'issue', step: 'done', status: 'done', started: 'now', tries: 0, rounds: {} },
};
const answering = new Set<string | null>();
vi.stubGlobal('studioServed', [served('live'), served('bench')]);
vi.stubGlobal('location', new URL('http://studio/runs'));
vi.stubGlobal(
  'fetch',
  vi.fn(async (url: string, init?: RequestInit) => {
    const { id } = JSON.parse(new TextDecoder().decode(init!.body as Uint8Array)) as { id: string };
    const instance = new URL(url, 'http://studio').searchParams.get('instance');
    const value = [{ ...run, instance, run: { ...run.run, id: `run-${instance}` } }];
    if (!answering.has(instance)) await new Promise(() => {});
    return new Response(`${JSON.stringify({ _tag: 'Exit', requestId: id, exit: { _tag: 'Success', value } })}\n`);
  })
);
afterAll(() => vi.unstubAllGlobals());

const { createElement } = await studioDependency<{ createElement: CreateElement }>('react');
const { renderToString } = await studioDependency<{ renderToString: (node: unknown) => string }>('react-dom/server');
const jotai = await studioDependency<{ createStore: () => Store; Provider: unknown }>('jotai');
const { RunsPage } = await studioModule<{ RunsPage: () => unknown }>('runs/RunsPage.tsx');
const { getRunsAtom } = await studioModule<{ getRunsAtom: (instance: string) => Atom }>('state.ts');

const render = (store: Store) => renderToString(createElement(jotai.Provider, { store }, createElement(RunsPage)));
const frame = (html: string) => html.slice(0, html.indexOf('<ol')).replace(/<!-- -->/g, '');

const renderOnceAnswered = async (instances: string[]) => {
  instances.forEach(name => answering.add(name));
  const store = jotai.createStore();
  const atoms = instances.map(getRunsAtom);
  const stops = atoms.map(atom => store.sub(atom, () => {}));
  await vi.waitFor(() => expect(atoms.every(atom => (store.get(atom) as { value?: unknown }).value)).toBe(true));
  const html = render(store);
  for (const stop of stops) stop();
  return html;
};

it('keeps the filters and the run list in place while runs load, the wait shown inside the filter row', async () => {
  const loading = [render(jotai.createStore()), await renderOnceAnswered(['live'])];
  const loaded = await renderOnceAnswered(['live', 'bench']);
  expect(loaded).not.toContain('role="status"');
  for (const html of loading) {
    expect(html).toContain('role="status"');
    expect(frame(html)).toMatch(/Issue.*<\/div>$/);
    expect(frame(html).replace(/<p role="status".*?<\/p>/, '')).toBe(frame(loaded));
  }
});
