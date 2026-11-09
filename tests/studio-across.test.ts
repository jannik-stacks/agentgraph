import { beforeAll, expect, it } from 'vitest';
import { studioDependency, studioModule } from './studio.ts';

type CreateElement = (type: unknown, props?: object | null, ...children: unknown[]) => unknown;

let html: string;
let makeInstanceHref: (href: string) => string;
const served = (name: string) => ({ name, title: name, local: false, problems: [] });

beforeAll(async () => {
  Object.assign(globalThis, {
    studioServed: [served('live'), served('bench')],
    location: { pathname: '/plugins/count', search: '', origin: 'http://127.0.0.1' },
    requestIdleCallback: () => 0,
  });
  const { createElement } = await studioDependency<{ createElement: CreateElement }>('react');
  const { renderToString } = await studioDependency<{ renderToString: (node: unknown) => string }>('react-dom/server');
  const jotai = await studioDependency<{ createStore: () => object; Provider: unknown }>('jotai');
  const { App } = await studioModule<{ App: () => unknown }>('App.tsx');
  ({ makeInstanceHref } = await studioModule<{ makeInstanceHref: typeof makeInstanceHref }>('state.ts'));
  html = renderToString(createElement(jotai.Provider, { store: jotai.createStore() }, createElement(App)));
});

it('serves a studio page outside every instance, with no instance tabs and every instance to pick', () => {
  expect({
    hrefs: [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map(m => m[1]),
    found: !html.includes('Page not found.') && !html.includes('serves no instance'),
    api: makeInstanceHref('/api/plugins/count/data'),
  }).toEqual({ hrefs: ['/', '/plugins/count'], found: true, api: '/api/plugins/count/data' });
  expect(html).toMatch(/<option value="" selected="">all instances<\/option><option value="live">live<\/option>/);
});
