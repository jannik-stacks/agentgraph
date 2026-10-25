import { Option, Schema } from 'effect';
import type { Piece } from '../src/harnesses.ts';

export const makeLineParser = <A, I>(schema: Schema.Schema<A, I>, parse: (line: A) => Piece[]) => {
  const decode = Schema.decodeUnknownOption(schema);
  return (line: unknown) => Option.match(decode(line), { onNone: () => [], onSome: parse });
};

export const makeOptionalFields = <S extends Schema.Schema.Any, K extends string>(schema: S, ...keys: K[]) =>
  Object.fromEntries(keys.map(key => [key, Schema.optional(schema)])) as Record<K, Schema.optional<S>>;

export const makeCacheCounts = (read = 0, write = 0) => ({
  ...(read > 0 && { cacheRead: read }),
  ...(write > 0 && { cacheWrite: write }),
});

export const modelTimeouts = { headersMs: 120_000, idleMs: 180_000 };

export const splitToolPattern = (tool: string) => /^([^(]+)\((.*)\)$/.exec(tool) ?? [tool, tool, undefined];

export const makePrefixedToolForms = (tools: string[]) =>
  tools.flatMap(tool => (tool.startsWith('bash(') ? [tool, `bash(NODE_OPTIONS= command ${tool.slice(5)}`] : [tool]));

export const getBlockText = (content: unknown, type = 'text'): string =>
  typeof content === 'string'
    ? type === 'text'
      ? content
      : ''
    : Array.isArray(content)
      ? content.flatMap(b => (b?.type === type && typeof b[type] === 'string' ? [b[type]] : [])).join('')
      : '';
