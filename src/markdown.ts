import { parse } from 'yaml';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Splits a Markdown file into YAML frontmatter and its trimmed body.
 * @throws when the frontmatter is missing.
 */
export const parseMarkdown = (source: string): { data: unknown; body: string } => {
  const match = FRONTMATTER.exec(source);
  if (!match) throw new Error('missing YAML frontmatter');
  return { data: parse(match[1] ?? ''), body: source.slice(match[0].length).trim() };
};
