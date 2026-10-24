// Naming rules for exports, as an oxlint plugin (see .oxlintrc.json) and a baseline tool. The rules and verbs are
// explained in docs/patterns.md#names. Violations listed in bin/names-baseline.txt are allowed until renamed.
//
//   npm run lint                  fails on a new violation
//   node bin/names.mjs            fails when the baseline lists a violation that is gone, or misses a new one
//   node bin/names.mjs --write    rewrites the baseline from today's violations
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const verbs = new Set(
  [
    ['parse', 'format', 'make', 'get', 'find', 'pick', 'split', 'sum', 'is', 'why'],
    ['read', 'write', 'append', 'copy', 'move', 'remove', 'create', 'ensure'],
    ['run', 'start', 'wait', 'poll', 'queue', 'propose', 'commit', 'merge', 'use'],
  ].flat()
);
const layer = /(Forge|Store|Session|Sandbox)$/;
const retired = /compound|climb|stamp|provenance|bothub/i;
const dirs = ['src', 'bin', 'bench', 'tune', 'studio/src'];
const root = process.cwd();
const baselinePath = join(root, 'bin/names-baseline.txt');

/** The problems of one exported function name, by rule. */
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
/** Each exported name in the linted dirs and the files that export it. */
const exportOwners = () => {
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
  process.env.AGENTGRAPH_NAMES_ALL || !existsSync(baselinePath)
    ? []
    : readFileSync(baselinePath, 'utf8').split('\n').filter(Boolean)
);

/** The names a top-level export statement declares, each with whether it is a function. */
const exported = node => {
  const d = node.declaration;
  if (!d) return [];
  if (d.type === 'FunctionDeclaration') return d.id ? [{ id: d.id, fn: true }] : [];
  if (d.type === 'VariableDeclaration')
    return d.declarations
      .filter(v => v.id.type === 'Identifier')
      .map(v => ({ id: v.id, fn: ['ArrowFunctionExpression', 'FunctionExpression'].includes(v.init?.type) }));
  return d.id?.type === 'Identifier' ? [{ id: d.id, fn: false }] : [];
};

const rule = (name, check, message) => ({
  create: context => {
    const file = relative(root, context.filename);
    return {
      ExportNamedDeclaration: node => {
        for (const { id, fn } of exported(node))
          if (check(id.name, fn, file) && !baseline.has(`${name} ${file} ${id.name}`))
            context.report({ node: id, message: message(id.name) });
      },
    };
  },
});

export default {
  meta: { name: 'names' },
  rules: {
    'verb-first': rule(
      'verb-first',
      (n, fn) => fn && findNameProblems(n).includes('verb-first'),
      n => `${n}: an exported function starts with a verb from docs/patterns.md#names`
    ),
    'no-of-for': rule(
      'no-of-for',
      (n, fn) => fn && findNameProblems(n).includes('no-of-for'),
      n => `${n}: name what the function does, not what it is of or for`
    ),
    'unique-export': rule(
      'unique-export',
      (n, _, file) => [...(exportOwners().get(n) ?? [])].some(f => f !== file),
      n => `${n}: another file exports the same name`
    ),
    'retired-word': rule(
      'retired-word',
      n => retired.test(n),
      n => `${n}: uses a retired word, see the vocabulary in docs/vocabulary.md`
    ),
  },
};

/** Today's violations as baseline lines, from oxlint with the baseline turned off. */
const violations = () => {
  let out;
  try {
    out = execFileSync(process.execPath, ['node_modules/oxlint/bin/oxlint', '-f', 'json', ...dirs], {
      encoding: 'utf8',
      env: { ...process.env, AGENTGRAPH_NAMES_ALL: '1' },
      maxBuffer: 1 << 26,
    });
  } catch (e) {
    out = e.stdout;
  }
  return JSON.parse(out)
    .diagnostics.filter(d => /^names\((verb-first|no-of-for|unique-export)\)/.test(d.code))
    .map(d => `${/\((.+)\)/.exec(d.code)[1]} ${d.filename} ${d.message.split(':')[0]}`)
    .sort();
};

if (process.argv[1] === import.meta.filename) {
  const now = violations();
  if (process.argv.includes('--write')) {
    writeFileSync(baselinePath, now.join('\n') + '\n');
    console.log(`${now.length} baseline entries`);
  } else {
    const fresh = now.filter(line => !baseline.has(line));
    const gone = [...baseline].filter(line => !now.includes(line));
    for (const line of fresh) console.log(`new: ${line}`);
    for (const line of gone) console.log(`renamed, drop from bin/names-baseline.txt: ${line}`);
    process.exit(fresh.length || gone.length ? 1 : 0);
  }
}
