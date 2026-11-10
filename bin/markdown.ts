import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

type Node = { position: { start: { line: number }; end: { line: number } } };

const fromStudio = createRequire(join(import.meta.dirname, '../studio/package.json'));
const load = (id: string) => import(pathToFileURL(fromStudio.resolve(id)).href);
const [{ fromMarkdown }, { gfm }, { gfmFromMarkdown: gfmTree }, { toString }, { visit }] = await Promise.all(
  [
    'mdast-util-from-markdown',
    'micromark-extension-gfm',
    'mdast-util-gfm',
    'mdast-util-to-string',
    'unist-util-visit',
  ].map(load)
);

const parseMarkdown = (text: string) => fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmTree()] });

export const findCodeBlocks = (text: string) => {
  const lines = text.split('\n');
  const blocks: { from: number; to: number; value: string; closed: boolean }[] = [];
  visit(parseMarkdown(text), 'code', ({ position: { start, end }, value }: Node & { value: string }) => {
    const open = /^\s*(`{3,}|~{3,})/.exec(lines[start.line - 1]!)?.[1];
    if (!open) return;
    const closing = new RegExp(`^\\s*${open[0]}{${open.length},}\\s*$`);
    blocks.push({
      from: start.line,
      to: end.line,
      value,
      closed: end.line > start.line && closing.test(lines[end.line - 1]!),
    });
  });
  return blocks;
};

export const findHeadings = (text: string) => {
  const headings: { line: number; text: string }[] = [];
  visit(parseMarkdown(text), 'heading', (node: Node) =>
    headings.push({ line: node.position.start.line, text: toString(node, { includeHtml: false }) })
  );
  return headings;
};
