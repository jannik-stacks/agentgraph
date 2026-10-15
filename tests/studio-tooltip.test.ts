import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { studioDir, studioModule } from './studio.ts';

const studioRequire = createRequire(join(studioDir, 'package.json'));
const dependency = <T>(name: string) =>
  import(/* @vite-ignore */ pathToFileURL(studioRequire.resolve(name)).href) as Promise<T>;

type Props = Record<string, unknown>;
let render: (props: Props) => string;
let tooltip: (html: string) => string;

beforeAll(async () => {
  Object.assign(globalThis, {
    location: { pathname: '/', search: '', origin: 'http://127.0.0.1' },
    requestIdleCallback: () => 0,
  });
  const { createElement } = await dependency<{ createElement: (t: unknown, p?: object, ...c: unknown[]) => unknown }>(
    'react'
  );
  const { renderToStaticMarkup } = await dependency<{ renderToStaticMarkup: (node: unknown) => string }>(
    'react-dom/server'
  );
  const { Tooltip } = await studioModule<{ Tooltip: unknown }>('ui.tsx');
  render = props => renderToStaticMarkup(createElement(Tooltip, props, createElement('button', {}, 'go')));
  tooltip = html => html.slice(html.indexOf('role="tooltip"'));
});

describe('Tooltip', () => {
  it('puts the explanation first and the action on its own line under it', () => {
    const body = tooltip(render({ tip: '3 notes matched', action: 'List them' }));
    expect(body.indexOf('3 notes matched')).toBeLessThan(body.indexOf('List them'));
    expect(body).toMatch(/<span class="block[^"]*">List them<\/span>/);
  });

  it('renders an action alone', () => {
    const body = tooltip(render({ action: 'Open the run' }));
    expect(body).toContain('Open the run');
    expect(body).not.toContain('<svg');
  });

  it('renders an explanation alone as plain text with no icon', () => {
    const body = tooltip(render({ tip: 'Started 2 minutes ago' }));
    expect(body).toContain('Started 2 minutes ago');
    expect(body).not.toContain('<svg');
  });

  it('describes the wrapped element by the tooltip', () => {
    const html = render({ tip: 'Model', action: 'Show details' });
    const id = /role="tooltip"[^>]*id="([^"]+)"|id="([^"]+)"[^>]*role="tooltip"/.exec(html);
    expect(html).toContain(`aria-describedby="${id?.[1] ?? id?.[2]}"`);
  });
});
