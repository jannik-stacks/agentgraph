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
  it.each(['unfinished', 'untested'])('renders %s as a status pill without changing the heading anchor', status => {
    const html = render({ text: `# Hosting <!-- ${status} -->` });
    expect(html).toMatch(/<h1\b[^>]*id="hosting"/);
    expect(html).toContain(`data-doc-status="${status}">${status}</span>`);
    expect(html).not.toContain('&lt;!--');
  });

  it('keeps custom and duplicate heading anchors with status markers', () => {
    const html = render({
      text: '# Hosting [#deploy] <!-- untested -->\n\n## Setup <!-- unfinished -->\n\n## Setup',
    });
    expect(html).toMatch(/<h1\b[^>]*id="deploy"/);
    expect(html).toMatch(/<h2\b[^>]*id="setup"/);
    expect(html).toContain('<h2 id="setup-1">');
  });

  it('groups formatted paragraph text beside its status and preserves spaces around a middle marker', () => {
    const html = render({ text: 'A <!-- unfinished -->**bold** [link](#a) and `code`.' });
    expect(html).toContain(
      '<span class="min-w-0">A <strong>bold</strong> <a href="#a">link</a> and <code>code</code>.</span>'
    );
    expect(html).toContain('data-doc-status="unfinished">unfinished</span>');
  });

  it('still leaves markers in code alone and hides ordinary HTML comments', () => {
    const html = render({
      text: '`<!-- untested -->`\n\n```md\n<!-- unfinished -->\n```\n\nText <!-- code: src/engine.ts#drive --> <!-- unknown -->',
    });
    expect(html).not.toContain('data-doc-status=');
    expect(html).toContain('<code>&lt;!-- untested --&gt;</code>');
    expect(html).toContain('&lt;!-- unfinished --&gt;');
    expect(html).not.toContain('src/engine.ts');
    expect(html).not.toContain('unknown');
  });

  it('still shows clean page names in docs navigation', async () => {
    const { DocsPage } = await studioModule<{ DocsPage: Element }>('docs/DocsPage.tsx');
    const html = renderToStaticMarkup(React.createElement(DocsPage));
    expect(html).toMatch(/href="\/docs\/hosting"[^>]*>Hosting<\/a>/);
    expect(html).not.toContain('&lt;!-- untested --&gt;');
  });

  it('renders inline code plainly and opens links in a new tab', () => {
    const html = render({ text: 'Run `agentgraph serve` before the [docs](https://example.com).' });
    expect(html).toMatch(/^<div class="agi-md">/);
    expect(html).toContain('<code>agentgraph serve</code>');
    expect(html).toMatch(/<a href="https:\/\/example.com" target="_blank" rel="noreferrer">docs<\/a>/);
  });

  it('gives headings GitHub anchors and keeps anchor links in the page', () => {
    const html = render({
      text: '## Tries and going back\n\nSee [waiting](#waiting) and [the loop](loop.md#waiting).',
    });
    expect(html).toContain('<h2 id="tries-and-going-back">');
    expect(html).toContain('<a href="#waiting">waiting</a>');
    expect(html).toContain('href="/docs/loop#waiting"');
  });

  it('renders GitHub tables', () => {
    expect(render({ text: '| a | b |\n| - | - |\n| `x` | 2 |' })).toContain('<table>');
  });
});
