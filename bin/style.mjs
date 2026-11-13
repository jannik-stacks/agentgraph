import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { formatRetiredAdvice, retiredWords } from '../src/retired.ts';

export const verbs = new Set(
  [
    ['parse', 'compile', 'format', 'make', 'get', 'find', 'pick', 'split', 'sum', 'is', 'why'],
    ['read', 'write', 'append', 'copy', 'move', 'remove', 'create', 'ensure'],
    ['run', 'start', 'wait', 'scan', 'queue', 'propose', 'commit', 'merge', 'use'],
  ].flat()
);
const exempt = new Set([
  'folderTracker',
  'githubTracker',
  'fileStore',
  'harnessSession',
  'dockerRunner',
  'boxRunner',
  'opencode',
  'claude',
  'pi',
  'some',
  'tool',
]);
const marked = /^\s*UNEXPECTED: /;
const directive = /^\s*(oxlint-|eslint-|@ts-|@vite-ignore\s*$|\*?\s*@(internal|public)\s*$)/;
const dirs = ['src', 'harnesses', 'bin', 'bench', 'tune', 'studio/src'];
const root = process.cwd();
const baselinePath = join(root, 'bin/style-baseline.txt');

const phrasalVerb = name => verbs.has(/^([a-z]+)(Of|For|From)[A-Z\d]/.exec(name)?.[1]);

export const findNameProblems = name => {
  if (/^[A-Z]/.test(name)) return [];
  const problems = [];
  const prepositions = [...name.matchAll(/[a-z\d](Of|For|From)(?=[A-Z\d]|$)/g)];
  if (prepositions.length > (phrasalVerb(name) ? 1 : 0)) problems.push('no-of-for');
  if (!verbs.has(/^[a-z]+/.exec(name)?.[0]) && !exempt.has(name)) problems.push('verb-first');
  return problems;
};

const findRetiredWordInName = name => {
  const words = new Set(
    name
      .replaceAll('GitHub', 'Github')
      .split(/(?<=[a-z\d])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|[^A-Za-z]+/)
      .map(word => word.toLowerCase())
  );
  return retiredWords.find(({ word }) => words.has(word) || words.has(`${word}s`));
};

const declaration =
  /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|function\*?|type|interface|class|enum)\s+([A-Za-z_$][\w$]*)/gm;
let owners;
const readExportOwners = () => {
  if (owners) return owners;
  owners = new Map();
  for (const dir of dirs.filter(d => existsSync(join(root, d))))
    for (const file of readdirSync(join(root, dir), { recursive: true })) {
      if (!/\.(ts|tsx|mjs)$/.test(file) || /node_modules/.test(file)) continue;
      const path = join(dir, file);
      for (const [, name] of readFileSync(join(root, path), 'utf8').matchAll(declaration))
        owners.set(name, new Set([...(owners.get(name) ?? []), path]));
    }
  return owners;
};

const baseline = new Set(
  process.env.AGENTGRAPH_STYLE_ALL || !existsSync(baselinePath)
    ? []
    : readFileSync(baselinePath, 'utf8').split('\n').filter(Boolean)
);

const reexport = /^export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'(\.[^']+)'/gm;
const readSurfaceNames = (file, out = new Set()) => {
  const text = readFileSync(join(root, file), 'utf8');
  for (const [, name] of text.matchAll(declaration)) out.add(`${file}#${name}`);
  for (const [, names, from] of text.matchAll(reexport)) {
    const source = join(dirname(file), from);
    for (const part of names
      .split(',')
      .map(n => n.trim().replace(/^type\s+/, ''))
      .filter(Boolean)) {
      const [name, as = name] = part.split(/\s+as\s+/);
      out.add(`${file}#${as}`);
      out.add(`${source}#${name}`);
    }
  }
  return out;
};
let surface;
const readSurface = () => {
  if (surface) return surface;
  surface = new Set();
  const pkg = join(root, 'package.json');
  const exported = existsSync(pkg) ? Object.values(JSON.parse(readFileSync(pkg, 'utf8')).exports ?? {}) : [];
  for (const entry of exported) {
    const src = /^\.\/dist\/(.+)\.mjs$/.exec(entry.import ?? entry)?.[1];
    if (src && existsSync(join(root, `src/${src}.ts`))) readSurfaceNames(`src/${src}.ts`, surface);
  }
  return surface;
};

const findSurfaceSpans = (file, body) =>
  body.flatMap(node =>
    node.type === 'ExportNamedDeclaration' &&
    getExportedNames(node).some(({ id }) => readSurface().has(`${file}#${id.name}`))
      ? [node.range]
      : []
  );

const isSurfaceDoc = (c, spans, text) =>
  c.type === 'Block' &&
  c.value.startsWith('*') &&
  spans.some(
    ([start, end]) =>
      (c.range[0] > start && c.range[1] < end) || (c.range[1] <= start && !text.slice(c.range[1], start).trim())
  );

const getExportedNames = node => {
  const d = node.declaration;
  if (!d) return [];
  if (d.type === 'FunctionDeclaration') return d.id ? [{ id: d.id, fn: true }] : [];
  if (d.type === 'VariableDeclaration')
    return d.declarations
      .filter(v => v.id.type === 'Identifier')
      .map(v => ({ id: v.id, fn: ['ArrowFunctionExpression', 'FunctionExpression'].includes(v.init?.type) }));
  return d.id?.type === 'Identifier' ? [{ id: d.id, fn: false }] : [];
};

const makeNameRule = (name, check, message) => ({
  create: context => {
    const file = relative(root, context.filename);
    return {
      ExportNamedDeclaration: node => {
        for (const { id, fn } of getExportedNames(node))
          if (check(id.name, fn, file) && !baseline.has(`${name} ${file} ${id.name}`))
            context.report({ node: id, message: message(id.name) });
      },
    };
  },
});

const noComment = {
  create: context => ({
    Program: program => {
      const file = relative(root, context.filename);
      const { text } = context.sourceCode;
      const spans = findSurfaceSpans(file, program.body);
      for (const c of context.sourceCode.getAllComments())
        if (c.type !== 'Shebang' && !marked.test(c.value) && !directive.test(c.value) && !isSurfaceDoc(c, spans, text))
          context.report({
            node: c,
            message: c.value.startsWith('*')
              ? 'tsdoc: TSDoc goes only on the published surface, see STYLE.md#comments-and-docs-links'
              : 'comment: delete it or start it with UNEXPECTED:',
          });
    },
  }),
};

const isJsonParse = node =>
  node?.type === 'ParenthesizedExpression' || node?.type === 'LogicalExpression'
    ? isJsonParse(node.expression ?? node.left)
    : node?.type === 'CallExpression' && node.callee.object?.name === 'JSON' && node.callee.property?.name === 'parse';

const noJsonCast = {
  create: context => ({
    TSAsExpression: node => {
      if (isJsonParse(node.expression) && node.typeAnnotation.type !== 'TSUnknownKeyword')
        context.report({ node, message: 'JSON.parse(...) as: decode it with parseJson and a schema' });
    },
  }),
};

export default {
  meta: { name: 'style' },
  rules: {
    'verb-first': makeNameRule(
      'verb-first',
      (n, fn) => fn && findNameProblems(n).includes('verb-first'),
      n =>
        `${n}: an exported function starts with a verb from docs/patterns.md#names, or is a layer constructor in STYLE.md#exceptions`
    ),
    'no-of-for': {
      create: context => {
        const file = relative(root, context.filename);
        const check = id => {
          if (!id) return;
          if (id.type === 'ObjectPattern') return id.properties.forEach(p => check(p.value ?? p.argument));
          if (id.type === 'ArrayPattern') return id.elements.forEach(check);
          if (id.type === 'AssignmentPattern') return check(id.left);
          if (id.type === 'RestElement') return check(id.argument);
          if (id.type !== 'Identifier' || !findNameProblems(id.name).includes('no-of-for')) return;
          if (!baseline.has(`no-of-for ${file} ${id.name}`))
            context.report({ node: id, message: `${id.name}: name what it does, not what it is of, for or from` });
        };
        const checkFunction = node => [node.id, ...node.params].forEach(check);
        return {
          VariableDeclarator: node => check(node.id),
          FunctionDeclaration: checkFunction,
          FunctionExpression: checkFunction,
          ArrowFunctionExpression: checkFunction,
        };
      },
    },
    'unique-export': makeNameRule(
      'unique-export',
      (n, _, file) => [...(readExportOwners().get(n) ?? [])].some(f => f !== file),
      n => `${n}: another file exports the same name`
    ),
    'retired-word': makeNameRule(
      'retired-word',
      n => findRetiredWordInName(n) !== undefined,
      n => {
        const retired = findRetiredWordInName(n);
        return `${n}: ${retired.word} is retired; ${formatRetiredAdvice(retired)} (src/retired.ts)`;
      }
    ),
    'type-suffix': {
      create: context => {
        const file = relative(root, context.filename);
        const check = ({ id }) => {
          const suffix = /[a-z\d](Config|Options|Index|Map)$/.exec(id.name)?.[1];
          if (suffix && !baseline.has(`type-suffix ${file} ${id.name}`))
            context.report({ node: id, message: `${id.name}: ${suffix} is not a type suffix, see STYLE.md#naming` });
        };
        return { TSTypeAliasDeclaration: check, TSInterfaceDeclaration: check };
      },
    },
    'no-comment': noComment,
    'no-json-cast': noJsonCast,
  },
};

const readViolations = () => {
  let out;
  try {
    out = execFileSync(process.execPath, ['node_modules/oxlint/bin/oxlint', '-f', 'json'], {
      encoding: 'utf8',
      env: { ...process.env, AGENTGRAPH_STYLE_ALL: '1' },
      maxBuffer: 1 << 28,
    });
  } catch (e) {
    out = e.stdout;
  }
  return JSON.parse(out)
    .diagnostics.flatMap(d => {
      const rule = /^style\(([\w-]+)\)/.exec(d.code)?.[1];
      return rule && rule !== 'no-comment' ? [`${rule} ${d.filename} ${d.message.split(':')[0]}`] : [];
    })
    .toSorted();
};

if (process.argv[1] === import.meta.filename) {
  const now = new Set(readViolations());
  const write = process.argv.includes('--write');
  const fresh = [...now].filter(line => !baseline.has(line));
  const [kept, gone] = [[...baseline].filter(line => now.has(line)), [...baseline].filter(line => !now.has(line))];
  for (const line of fresh) console.log(`new, fix it or add a reviewed exception to bin/style-baseline.txt: ${line}`);
  if (write) writeFileSync(baselinePath, kept.join('\n') + '\n');
  for (const line of gone) console.log(write ? `removed: ${line}` : `fixed, run node bin/style.mjs --write: ${line}`);
  process.exit(fresh.length || (gone.length && !write) ? 1 : 0);
}
