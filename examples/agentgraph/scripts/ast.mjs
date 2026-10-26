// TypeScript and TSX parsed with the parser the studio already installs, and helpers over the tree it gives.
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const resolveParser = () => {
  for (const from of [join(process.cwd(), 'studio/package.json'), new URL('../../../studio/package.json', import.meta.url)])
    try {
      return createRequire(from).resolve('rolldown/parseAst');
    } catch {}
  throw new Error('rolldown/parseAst is missing: the studio dependencies must be installed to parse TSX');
};

const { parseAst } = await import(pathToFileURL(resolveParser()).href);

const pickParserLang = path => ({ '.tsx': 'tsx', '.ts': 'ts', '.mts': 'ts', '.jsx': 'jsx' })[extname(path)] ?? 'js';

/** The program of `code`, or the parse error message. */
export const parseSourceFileToAst = (path, code) => {
  try {
    return { program: parseAst(code, { lang: pickParserLang(path) }) };
  } catch (error) {
    return { error: String(error.message ?? error).split('\n')[0] };
  }
};

/** The 1-based line of a character offset. */
export const makeOffsetToLineLookup = code => {
  const starts = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') starts.push(i + 1);
  return offset => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
};

/** Calls `visit(node, parents)` for every node, depth first, parents nearest last. */
export const walk = (node, visit, parents = []) => {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, parents);
    return;
  }
  if (typeof node.type === 'string') visit(node, parents);
  const next = typeof node.type === 'string' ? [...parents, node] : parents;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'start' || key === 'end' || !value || typeof value !== 'object') continue;
    walk(value, visit, next);
  }
};

/** The tag name of a JSX element, `a.b` for member names. */
export const getJsxTag = element => {
  const name = element.openingElement?.name;
  if (!name) return '';
  if (name.type === 'JSXIdentifier') return name.name;
  if (name.type === 'JSXMemberExpression') return `${getJsxTag({ openingElement: { name: name.object } })}.${name.property.name}`;
  return '';
};

export const isNative = tag => /^[a-z]/.test(tag);

/** The attribute `name` of a JSX element. */
export const getJsxAttr = (element, name) =>
  element.openingElement?.attributes?.find(a => a.type === 'JSXAttribute' && a.name?.name === name);

/** The literal string an attribute holds, when it holds one. */
export const attrText = attribute => {
  const value = attribute?.value;
  if (!value) return undefined;
  if (value.type === 'Literal' && typeof value.value === 'string') return value.value;
  const expression = value.type === 'JSXExpressionContainer' ? value.expression : undefined;
  if (expression?.type === 'Literal' && typeof expression.value === 'string') return expression.value;
  if (expression?.type === 'TemplateLiteral') return expression.quasis.map(q => q.value.cooked ?? q.value.raw).join('…');
  return undefined;
};

/** Children that render something: whitespace-only text and empty expressions dropped. */
export const meaningful = children =>
  (children ?? []).filter(
    child =>
      !(child.type === 'JSXText' && !child.value.trim()) &&
      !(child.type === 'JSXExpressionContainer' && child.expression?.type === 'JSXEmptyExpression')
  );

/** Reports findings on the lines that count, in the shape every script check prints. */
export const reporter = () => {
  const findings = [];
  const add = (source, line, message) => {
    if (source.lines && !source.lines.some(l => l.line === line)) return;
    findings.push(`${source.path}:${line}: ${message}`);
  };
  return { findings, add };
};
