import { parse } from 'yaml';

export type MarkdownDoc = {
  data: unknown;
  body: string;
  sections: Record<string, string>;
};

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const SECTION = /^## +(\S+)[ \t]*$/gm;

/**
 * Splits a Markdown file into YAML frontmatter, the full body, and `## <id>` sections.
 * @throws when the frontmatter is missing or a section id repeats.
 */
export const parseMarkdown = (source: string): MarkdownDoc => {
  const match = FRONTMATTER.exec(source);
  if (!match) throw new Error('missing YAML frontmatter');
  const body = source.slice(match[0].length).trim();
  return { data: parse(match[1] ?? ''), body, sections: splitSections(body) };
};

const splitSections = (body: string): Record<string, string> => {
  const heads = [...body.matchAll(SECTION)];
  const sections: Record<string, string> = {};
  heads.forEach((head, i) => {
    const id = head[1] as string;
    if (id in sections) throw new Error(`duplicate section "## ${id}"`);
    const end = heads[i + 1]?.index ?? body.length;
    sections[id] = body.slice(head.index + head[0].length, end).trim();
  });
  return sections;
};
