import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const verbs = new Set(
  [
    ['parse', 'compile', 'format', 'make', 'get', 'find', 'pick', 'split', 'sum', 'is', 'why'],
    ['read', 'write', 'append', 'copy', 'move', 'remove', 'create', 'ensure'],
    ['run', 'start', 'wait', 'poll', 'queue', 'propose', 'commit', 'merge', 'use'],
  ].flat()
);
const layer = /(Forge|Store|Session|Sandbox)$/;
const retired = /compound|climb|stamp|provenance|bothub/i;
const marked = /^\s*UNEXPECTED: /;
const directive = /^\s*(oxlint-|eslint-|@ts-|\*?\s*@internal\s*$)/;
const dirs = ['src', 'bin', 'bench', 'tune', 'studio/src'];
const root = process.cwd();
const baselinePath = join(root, 'bin/style-baseline.txt');

export const findNameProblems = name => {
  if (/^[A-Z]/.test(name)) return [];
  const problems = [];
  if (/[a-z\d](Of|For)$/.test(name)) problems.push('no-of-for');
  if (!verbs.has(/^[a-z]+/.exec(name)?.[0]) && !layer.test(name)) problems.push('verb-first');
  return problems;
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
const allowedComments = file =>
  Number([...baseline].find(line => line.startsWith(`no-comment ${file} `))?.split(' ')[2] ?? 0);

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
    Program: () => {
      const file = relative(root, context.filename);
      const found = context.sourceCode.getAllComments().filter(c => !marked.test(c.value) && !directive.test(c.value));
      const allowed = allowedComments(file);
      if (found.length <= allowed) return;
      if (allowed)
        context.report({
          node: found[0],
          message: `${found.length} comments, the baseline allows ${allowed}: delete one or start it with UNEXPECTED:`,
        });
      else
        for (const c of found) context.report({ node: c, message: 'comment: delete it or start it with UNEXPECTED:' });
    },
  }),
};

export default {
  meta: { name: 'style' },
  rules: {
    'verb-first': makeNameRule(
      'verb-first',
      (n, fn) => fn && findNameProblems(n).includes('verb-first'),
      n => `${n}: an exported function starts with a verb from docs/patterns.md#names`
    ),
    'no-of-for': makeNameRule(
      'no-of-for',
      (n, fn) => fn && findNameProblems(n).includes('no-of-for'),
      n => `${n}: name what the function does, not what it is of or for`
    ),
    'unique-export': makeNameRule(
      'unique-export',
      (n, _, file) => [...(readExportOwners().get(n) ?? [])].some(f => f !== file),
      n => `${n}: another file exports the same name`
    ),
    'retired-word': makeNameRule(
      'retired-word',
      n => retired.test(n),
      n => `${n}: uses a retired word, see docs/vocabulary.md`
    ),
    'no-comment': noComment,
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
  const comments = new Map();
  const names = [];
  for (const d of JSON.parse(out).diagnostics) {
    const rule = /^style\((verb-first|no-of-for|unique-export|no-comment)\)/.exec(d.code)?.[1];
    if (rule === 'no-comment') comments.set(d.filename, (comments.get(d.filename) ?? 0) + 1);
    else if (rule) names.push(`${rule} ${d.filename} ${d.message.split(':')[0]}`);
  }
  return [...names, ...[...comments].map(([file, n]) => `no-comment ${file} ${n}`)].sort();
};

if (process.argv[1] === import.meta.filename) {
  const now = readViolations();
  if (process.argv.includes('--write')) {
    writeFileSync(baselinePath, now.join('\n') + '\n');
    console.log(`${now.length} baseline entries`);
  } else {
    const fresh = now.filter(line => !baseline.has(line));
    const gone = [...baseline].filter(line => !now.includes(line));
    for (const line of fresh) console.log(`not in bin/style-baseline.txt: ${line}`);
    for (const line of gone) console.log(`fixed, run node bin/style.mjs --write: ${line}`);
    process.exit(fresh.length || gone.length ? 1 : 0);
  }
}
