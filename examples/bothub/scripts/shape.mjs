// What a change does to the exported surface of the TypeScript under the roots it is given, base against worktree:
// names added, removed and moved, fields added and removed, new types that near-duplicate an existing one, added
// names nothing imports, new import cycles and a longer import chain. Usage: node shape.mjs <root>...
// The same file is in every hub that runs it.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { posix } from 'node:path';

const maxLines = 15;
const minFields = 3;

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const lines = text => text.split('\n').filter(Boolean);
const isTest = path => /\.(test|spec)\.|(^|\/)(tests?|__tests__)\//.test(path);
const source = path => /\.(ts|tsx|mts)$/.test(path) && !path.endsWith('.d.ts') && !isTest(path);
const rootOf = path => process.argv.slice(2).find(root => path.startsWith(`${root}/`));
const short = path => path.replace(/\.(ts|tsx|mts)$/, '');

const parser = (() => {
  for (const from of [
    `${process.cwd()}/`,
    ...process.argv.slice(2).map(root => `${process.cwd()}/${root}/`),
    import.meta.url,
  ])
    try {
      return createRequire(from)('@babel/parser');
    } catch {}
})();

const sha = process.env.BOTHUB_BASE;
if (!sha) throw new Error('BOTHUB_BASE is not set, so there is no change to check');
const roots = process.argv.slice(2).filter(root => existsSync(root));
const changed = new Set(
  roots.length
    ? [
        ...lines(git('diff', '--name-only', '--relative', '--no-renames', sha, '--', ...roots)),
        ...lines(git('ls-files', '--others', '--exclude-standard', '--', ...roots)),
      ].filter(source)
    : []
);
if (!changed.size || !parser) {
  console.log(
    `shape: ${parser ? 'no TypeScript change' : 'skipped, @babel/parser is not installed'} under ${process.argv.slice(2).join(' ')}`
  );
  process.exit(0);
}

const files = {
  base: new Set(lines(git('ls-tree', '-r', '--name-only', sha, '--', ...roots)).filter(source)),
  head: new Set(
    lines(git('ls-files', '-co', '--exclude-standard', '--', ...roots)).filter(p => source(p) && existsSync(p))
  ),
};
const textOf = (side, path) =>
  side === 'base' && changed.has(path) ? git('show', `${sha}:./${path}`) : readFileSync(path, 'utf8');

const keyOf = key => (key?.type === 'Identifier' ? key.name : key?.type === 'StringLiteral' ? key.value : undefined);
const typeArgs = node => (node.typeParameters ?? node.typeArguments)?.params ?? [];
const literals = node =>
  node?.type === 'TSUnionType'
    ? node.types.flatMap(literals)
    : node?.type === 'TSLiteralType'
      ? [node.literal.value]
      : [];
const refName = name => (name.type === 'Identifier' ? name.name : `${refName(name.left)}.${name.right.name}`);
const objectKeys = node =>
  node?.type === 'ObjectExpression' ? node.properties.map(p => keyOf(p.key)).filter(Boolean) : null;
const union = parts => (parts.some(p => !p) ? null : [...new Set(parts.flat())]);

/** The field names of a type or zod schema, following the derivations written in the same file, or null. */
const fieldsOf = (node, local, seen = new Set()) => {
  const of = next => fieldsOf(next, local, seen);
  const named = (name, space = 'type') => {
    if (seen.has(`${space}:${name}`) || !local[space].has(name)) return null;
    seen.add(`${space}:${name}`);
    return of(local[space].get(name));
  };
  switch (node?.type) {
    case 'TSTypeLiteral':
      return node.members.map(m => keyOf(m.key)).filter(Boolean);
    case 'TSInterfaceDeclaration':
      return union([
        node.body.body.map(m => keyOf(m.key)).filter(Boolean),
        ...(node.extends ?? []).map(h => named(keyOf(h.expression))),
      ]);
    case 'TSTypeAliasDeclaration':
    case 'TSParenthesizedType':
      return of(node.typeAnnotation);
    case 'TSIntersectionType':
      return union(node.types.map(of));
    case 'VariableDeclarator':
      return of(node.init);
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
      return of(node.expression);
    case 'Identifier':
      return named(node.name, 'value');
    case 'TSTypeReference': {
      const [first, second] = typeArgs(node);
      const name = refName(node.typeName);
      if (['Partial', 'Required', 'Readonly', 'NonNullable'].includes(name)) return of(first);
      if (name === 'Omit') return of(first)?.filter(f => !literals(second).includes(f)) ?? null;
      if (name === 'Pick') return literals(second);
      if (/^z\.(infer|input|output|TypeOf)$/.test(name))
        return first?.type === 'TSTypeQuery' ? named(refName(first.exprName), 'value') : null;
      return named(name);
    }
    case 'CallExpression': {
      if (node.callee.type !== 'MemberExpression') return null;
      const method = keyOf(node.callee.property);
      const on = node.callee.object;
      if (on.type === 'Identifier' && on.name === 'z')
        return /^(object|strictObject|looseObject)$/.test(method) ? objectKeys(node.arguments[0]) : null;
      if (method === 'extend') return union([of(on), objectKeys(node.arguments[0])]);
      if (method === 'pick') return objectKeys(node.arguments[0]);
      if (method === 'omit') return of(on)?.filter(f => !objectKeys(node.arguments[0])?.includes(f)) ?? null;
      return of(on);
    }
  }
  return null;
};

const zodRoot = node =>
  node?.type === 'CallExpression'
    ? zodRoot(node.callee)
    : node?.type === 'MemberExpression'
      ? zodRoot(node.object)
      : node?.type === 'Identifier' && node.name === 'z';

const kindOf = node => {
  if (node.type === 'VariableDeclarator') {
    let init = node.init;
    while (init && /^TS(As|Satisfies)Expression$/.test(init.type)) init = init.expression;
    return /FunctionExpression$/.test(init?.type ?? '') ? 'function' : zodRoot(init) ? 'schema' : 'value';
  }
  return (
    {
      FunctionDeclaration: 'function',
      TSDeclareFunction: 'function',
      ClassDeclaration: 'class',
      TSInterfaceDeclaration: 'interface',
      TSTypeAliasDeclaration: 'type',
      TSEnumDeclaration: 'enum',
    }[node.type] ?? 'value'
  );
};

/** One file's exports, with kind, fields and declaration text, and its imports by specifier. */
const parse = (path, text) => {
  let program;
  try {
    program = parser.parse(text, {
      sourceType: 'module',
      errorRecovery: true,
      plugins: ['typescript', ...(path.endsWith('x') ? ['jsx'] : [])],
    }).program;
  } catch {
    return { exports: new Map(), imports: [] };
  }
  const local = { type: new Map(), value: new Map() };
  const space = node => (/^TS(Interface|TypeAlias)Declaration$/.test(node.type) ? 'type' : 'value');
  const declared = node =>
    node.type === 'VariableDeclaration'
      ? node.declarations.filter(d => d.id.type === 'Identifier').map(d => [d.id.name, d])
      : node.id?.name
        ? [[node.id.name, node]]
        : [];
  for (const st of program.body)
    for (const [name, node] of declared(st.declaration ?? st)) local[space(node)].set(name, node);
  const exports = new Map();
  const imports = [];
  const add = (name, node) => {
    const was = exports.get(name);
    const fields = node && fieldsOf(node, local);
    if (!node) exports.set(name, was ?? { kind: 're-export' });
    else
      exports.set(name, {
        kind: was?.kind ?? kindOf(node),
        fields: was?.fields ?? fields,
        text: `${was?.text ?? ''}${text.slice(node.start, node.end)}`,
      });
  };
  for (const st of program.body) {
    const from = st.source?.value;
    if (st.type === 'ImportDeclaration')
      imports.push({
        from,
        names: st.specifiers.map(s =>
          s.type === 'ImportSpecifier' ? keyOf(s.imported) : s.type === 'ImportDefaultSpecifier' ? 'default' : '*'
        ),
      });
    if (st.type === 'ExportAllDeclaration') {
      imports.push({ from, names: ['*'], forwards: true });
      exports.set(st.exported ? keyOf(st.exported) : `* from ${from}`, { kind: 're-export' });
    }
    if (st.type === 'ExportDefaultDeclaration') add('default', st.declaration);
    if (st.type !== 'ExportNamedDeclaration') continue;
    if (st.declaration) for (const [name, node] of declared(st.declaration)) add(name, node);
    for (const s of st.specifiers)
      add(keyOf(s.exported), from ? undefined : (local.type.get(keyOf(s.local)) ?? local.value.get(keyOf(s.local))));
    if (from) imports.push({ from, names: st.specifiers.map(s => (s.local ? keyOf(s.local) : '*')), forwards: true });
  }
  for (const [, from] of text.matchAll(/\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g))
    imports.push({ from, names: ['*'], dynamic: true });
  return { exports, imports };
};

const parsed = new Map();
const shapeOf = (side, path) => {
  const key = side === 'base' && changed.has(path) ? `base:${path}` : path;
  if (!parsed.has(key)) parsed.set(key, parse(path, textOf(side, path)));
  return parsed.get(key);
};

/** The file a relative import specifier names, among `known`. */
const resolveIn = (known, path, from) => {
  if (!from?.startsWith('.')) return;
  const at = posix.join(posix.dirname(path), from);
  const stem = at.replace(/\.(m?js|jsx|ts|tsx|mts)$/, '');
  return [at, ...['.ts', '.tsx', '.mts', '/index.ts', '/index.tsx'].map(ext => stem + ext)].find(p => known(p));
};

/** Cycles and the longest import chain of one side's module graph, cycles folded into one node. */
const graphOf = (side, root) => {
  const nodes = [...files[side]].filter(p => rootOf(p) === root);
  const edges = new Map(
    nodes.map(n => [
      n,
      [
        ...new Set(
          shapeOf(side, n)
            .imports.filter(i => !i.dynamic)
            .map(i => resolveIn(p => files[side].has(p) && rootOf(p) === root, n, i.from))
            .filter(Boolean)
        ),
      ],
    ])
  );
  const index = new Map();
  const low = new Map();
  const stack = [];
  const comp = new Map();
  const comps = [];
  const visit = v => {
    index.set(v, index.size);
    low.set(v, index.get(v));
    stack.push(v);
    for (const w of edges.get(v)) {
      if (!index.has(w)) visit(w);
      if (!comp.has(w)) low.set(v, Math.min(low.get(v), low.get(w)));
    }
    if (low.get(v) !== index.get(v)) return;
    const members = [];
    let w;
    do {
      w = stack.pop();
      comp.set(w, comps.length);
      members.push(w);
    } while (w !== v);
    comps.push(members);
  };
  for (const n of nodes) if (!index.has(n)) visit(n);
  const depth = new Map();
  const depthOf = c => {
    if (!depth.has(c)) {
      let best = { d: 0 };
      for (const v of comps[c])
        for (const w of edges.get(v))
          if (comp.get(w) !== c && depthOf(comp.get(w)).d + 1 > best.d)
            best = { d: depth.get(comp.get(w)).d + 1, via: comp.get(w) };
      depth.set(c, best);
    }
    return depth.get(c);
  };
  let top = 0;
  for (let c = 0; c < comps.length; c++) if (depthOf(c).d > depthOf(top).d) top = c;
  const chain = [];
  for (let c = comps.length ? top : undefined; c !== undefined; c = depth.get(c).via)
    chain.push(comps[c].length > 1 ? `{${comps[c].length} modules}` : short(comps[c][0]));
  return {
    size: nodes.length,
    comp,
    cycles: comps.filter(c => c.length > 1),
    depth: comps.length ? depthOf(top).d : 0,
    chain,
  };
};

const added = [];
const removed = [];
const fields = [];
for (const path of [...changed].sort()) {
  const before = files.base.has(path) ? shapeOf('base', path).exports : new Map();
  const after = files.head.has(path) ? shapeOf('head', path).exports : new Map();
  for (const [name, e] of after) if (!before.has(name)) added.push({ path, name, ...e });
  for (const [name, e] of before) if (!after.has(name)) removed.push({ path, name, ...e });
  for (const [name, e] of after) {
    const was = before.get(name)?.fields;
    if (!was || !e.fields) continue;
    const plus = e.fields.filter(f => !was.includes(f)).map(f => `+${f}`);
    const minus = was.filter(f => !e.fields.includes(f)).map(f => `-${f}`);
    if (plus.length || minus.length)
      fields.push({ line: `~ ${path} ${name}: ${[...plus, ...minus].join(' ')}`, plus, minus });
  }
}
const movedFrom = new Map(removed.filter(r => added.some(a => a.name === r.name)).map(r => [r.name, r.path]));
const fresh = added.filter(a => !movedFrom.has(a.name));
const gone = removed.filter(r => !movedFrom.has(r.name));

/** Files that name one of the added exports or re-export a whole module, the only ones worth parsing for importers. */
const grep = (...args) => {
  try {
    return lines(git('grep', '-l', '--untracked', ...args, '--', '*.ts', '*.tsx', '*.mts', '*.mjs', '*.js'));
  } catch {
    return [];
  }
};
const names = fresh.filter(a => a.kind !== 're-export').map(a => a.name);
const mentions = names.length
  ? new Set([...grep('-w', '-F', ...names.flatMap(n => ['-e', n])), ...grep('-E', '-e', '^export \\* ')])
  : [];
const importsOf = new Map([...mentions].map(file => [file, parse(file, readFileSync(file, 'utf8')).imports]));

/** The files a root's nearest package.json names in `exports`, `main` or `module`. */
const entries = new Set(
  roots.flatMap(root => {
    for (let dir = root; ; dir = posix.dirname(dir)) {
      const file = posix.join(dir, 'package.json');
      if (existsSync(file)) {
        const pkg = JSON.parse(readFileSync(file, 'utf8'));
        const leaves = v =>
          typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(leaves) : [];
        return leaves([pkg.exports, pkg.main, pkg.module]).map(p => posix.join(dir, p));
      }
      if (dir === '.') return [];
    }
  })
);
const isEntry = path => entries.has(path) || /(^|\/)index\.\w+$/.test(path);

/** Who imports `name` from `path`: other code, tests, or a package entry that makes it public. */
const users = ({ path, name }) => {
  const found = { code: [], tests: 0, public: entries.has(path) };
  for (const [file, imports] of importsOf) {
    const use =
      file !== path &&
      imports.find(i => resolveIn(p => p === path, file, i.from) && (i.names.includes(name) || i.names.includes('*')));
    if (!use) continue;
    if (use.forwards && isEntry(file)) found.public = true;
    else if (isTest(file)) found.tests++;
    else found.code.push(file);
  }
  return found;
};

const objects = [...files.head].flatMap(path =>
  [...shapeOf('head', path).exports]
    .filter(([, e]) => e.fields?.length >= minFields)
    .map(([name, e]) => ({ path, name, fields: e.fields, text: e.text }))
);
const word = name => new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`);
const count = (n, what) => `${n} ${what}${n === 1 ? '' : 's'}`;
const findings = [];
const unused = new Map();
const generated = path => /\bgenerated\b|do not edit/i.test(textOf('head', path).slice(0, 300));
const plusLines = new Map();
const paired = new Set();
for (const a of fresh) {
  let note = '';
  if (a.kind !== 're-export') {
    const u = users(a);
    const who = u.public
      ? 'public'
      : u.code.length === 1
        ? `1 importer, ${short(u.code[0])}`
        : u.code.length
          ? `${u.code.length} importers`
          : 'no importer';
    note = ` (${who}${u.tests ? `, ${count(u.tests, 'test')}` : ''})`;
    if (!u.public && !u.code.length && !u.tests && !generated(a.path))
      unused.set(a.path, [...(unused.get(a.path) ?? []), a.name]);
  }
  plusLines.set(a.path, [...(plusLines.get(a.path) ?? []), `${a.name} ${a.kind}${note}`]);
  if (!(a.fields?.length >= minFields) || generated(a.path)) continue;
  for (const o of objects) {
    const pair = [`${a.path} ${a.name}`, `${o.path} ${o.name}`].sort().join(' and ');
    if ((o.path === a.path && o.name === a.name) || rootOf(o.path) !== rootOf(a.path)) continue;
    if (paired.has(pair) || word(o.name).test(a.text) || word(a.name).test(o.text)) continue;
    paired.add(pair);
    const shared = a.fields.filter(f => o.fields.includes(f)).length;
    const all = new Set([...a.fields, ...o.fields]).size;
    if (shared / all >= 0.6 || (shared / Math.min(a.fields.length, o.fields.length) >= 0.85 && shared >= 4))
      findings.push(`near-duplicate: ${pair} share ${shared} of ${all} fields`);
  }
}
for (const [path, names] of unused) findings.push(`unused: ${path} ${names.join(', ')}`);
const minusLines = new Map();
for (const r of gone) minusLines.set(r.path, [...(minusLines.get(r.path) ?? []), r.name]);

const graphs = roots.map(root => {
  const base = graphOf('base', root);
  const head = graphOf('head', root);
  const label = roots.length > 1 ? `${root}: ` : '';
  for (const cycle of head.cycles) {
    const at = base.comp.get(cycle[0]);
    if (base.cycles.some(c => c.includes(cycle[0])) && cycle.every(m => base.comp.get(m) === at)) continue;
    const grown = base.cycles.find(c => c.some(m => cycle.includes(m)));
    findings.push(
      grown
        ? `${label}cycle grows from ${grown.length} to ${cycle.length} modules, adding ${cycle
            .filter(m => !grown.includes(m))
            .map(short)
            .join(', ')}`
        : `${label}new cycle: ${cycle.map(short).sort().join(', ')}`
    );
  }
  const inCycles = g => g.cycles.reduce((n, c) => n + c.length, 0);
  if (base.size && head.depth > base.depth && inCycles(head) >= inCycles(base))
    findings.push(`${label}deeper: longest import chain ${base.depth} → ${head.depth}, ${head.chain.join(' > ')}`);
  return `${label}cycles ${base.cycles.length} → ${head.cycles.length}, depth ${base.depth} → ${head.depth}`;
});

const show = list => {
  for (const line of list.slice(0, maxLines)) console.log(line);
  if (list.length > maxLines) console.log(`and ${list.length - maxLines} more`);
};
show([
  ...[...plusLines].map(([path, names]) => `+ ${path}: ${names.join(', ')}`),
  ...[...minusLines].map(([path, names]) => `- ${path}: ${names.join(', ')}`),
  ...[...movedFrom].map(([name, from]) => `moved ${name}: ${from} → ${added.find(a => a.name === name).path}`),
  ...fields.map(f => f.line),
]);
show(findings);
const sum = key => fields.reduce((n, f) => n + f[key].length, 0);
console.log(
  `shape: +${fresh.length} -${gone.length} names, ${movedFrom.size} moved, +${sum('plus')} -${sum('minus')} fields, ` +
    `${graphs.join(', ')}, ${count(findings.length, 'finding')}`
);
if (findings.length) process.exitCode = 1;
