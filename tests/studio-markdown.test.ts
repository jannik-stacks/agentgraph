import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { studioDir, studioModule } from './studio.ts';

Object.assign(globalThis, {
  location: new URL('http://localhost/runs'),
  addEventListener: () => {},
  removeEventListener: () => {},
});

const fromStudio = createRequire(join(studioDir, 'package.json'));
const load = <T>(id: string) => import(/* @vite-ignore */ pathToFileURL(fromStudio.resolve(id)).href) as Promise<T>;

type Element = (props: Record<string, unknown>) => unknown;
const React = await load<{ createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown }>(
  'react'
);
const { renderToStaticMarkup } = await load<{ renderToStaticMarkup: (node: unknown) => string }>('react-dom/server');
const { Markdown } = await studioModule<{ Markdown: Element }>('Markdown.tsx');

const render = (props: Record<string, unknown>) => renderToStaticMarkup(React.createElement(Markdown, props));

describe('Markdown in the studio', () => {
  it('renders inline code plainly and opens links in a new tab', () => {
    const html = render({ text: 'Run `agentgraph serve` before the [docs](https://example.com).' });
    expect(html).toMatch(/^<div class="agi-md">/);
    expect(html).toContain('<code>agentgraph serve</code>');
    expect(html).toMatch(/<a href="https:\/\/example.com" target="_blank" rel="noreferrer">docs<\/a>/);
  });

  it('renders GitHub tables', () => {
    expect(render({ text: '| a | b |\n| - | - |\n| `x` | 2 |' })).toContain('<table>');
  });
});
