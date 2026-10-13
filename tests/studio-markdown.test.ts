import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { studioDir, studioModule } from './studio.ts';

Object.assign(globalThis, {
  location: new URL('http://localhost/dashboard'),
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
const { evaluate } = await load<{ evaluate: (text: string, options: unknown) => Promise<{ default: Element }> }>(
  '@mdx-js/mdx'
);
const runtime = await load<object>('react/jsx-runtime');
const { default: mdxComponents } = await load<{ default: object }>('fumadocs-ui/mdx');
const { Markdown } = await studioModule<{ Markdown: Element }>('Markdown.tsx');

const text = 'Run `bothub serve` before the [docs](https://example.com).';

const docs = async () => {
  const { default: Content } = await evaluate(text, runtime);
  return renderToStaticMarkup(
    React.createElement('div', { className: 'prose' }, React.createElement(Content, { components: mdxComponents }))
  );
};

const codeSpans = (html: string) => html.match(/<code[^>]*>[^<]*<\/code>/g);
const proseRoot = (html: string) => /^<div class="([^"]*)"/.exec(html)?.[1]?.split(' ') ?? [];

describe('Markdown in the studio', () => {
  it('renders inline code with the same element and classes as the docs', async () => {
    const studio = renderToStaticMarkup(React.createElement(Markdown, { text }));
    expect(codeSpans(studio)).toEqual(codeSpans(await docs()));
    expect(codeSpans(studio)).toEqual(['<code>bothub serve</code>']);
  });

  it('styles it through the docs prose, scaled rather than overridden', () => {
    const classes = proseRoot(renderToStaticMarkup(React.createElement(Markdown, { text })));
    expect(classes).toContain('prose');
    expect(classes).toContain('[--tw-prose-size:0.8125]');
    expect(classes.some(c => /^text-\[|^leading-|not-prose/.test(c))).toBe(false);
  });
});
