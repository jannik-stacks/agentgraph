// Structure rules on the TypeScript a change adds under src/ and studio/src: components defined at module level,
// routes loaded lazily, the members of a tagged `Schema.Union` tagged by one shared key, and the studio's UI rules on
// its TSX. A softer hint, state copied in an effect, is printed without failing the check. In the graph scripts, a
// field an item sends to a model that gathers text with no clip or limit fails.
import { makeOffsetToLineLookup, parseSourceFileToAst, reporter, walk } from './ast.mjs';
import { readCheckInputFiles, report } from './changes.mjs';
import { studioFile, studioUi } from './studio-ui.mjs';

const code = path => /^(src|studio\/src)\/.*\.(ts|tsx|mts)$/.test(path) && !path.startsWith('studio/src/lab/');
const slicer = path => /^examples\/agentgraph\/scripts\/.*\.mjs$/.test(path);
const entries = new Set(['studio/src/App.tsx', 'studio/src/main.tsx']);

const functions = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const wrappers = new Set(['lazy', 'memo', 'forwardRef']);
const calleeName = call => (call.callee.type === 'MemberExpression' ? call.callee.property.name : call.callee.name);

const hasJsx = node => {
  let found = false;
  walk(node, child => {
    if (child.type === 'JSXElement' || child.type === 'JSXFragment') found = true;
  });
  return found;
};

const valueImports = program =>
  program.body.flatMap(node => {
    if (node.type === 'ImportDeclaration' && node.importKind !== 'type') {
      const values = !node.specifiers.length || node.specifiers.some(s => s.importKind !== 'type');
      return values ? [node] : [];
    }
    if ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source) {
      return node.exportKind === 'type' ? [] : [node];
    }
    return [];
  });

const isSchemaCall = (node, name) =>
  node?.type === 'CallExpression' &&
  node.callee.type === 'MemberExpression' &&
  node.callee.object.name === 'Schema' &&
  node.callee.property.name === name;

const findStructTags = (node, structs) => {
  const struct = node?.type === 'Identifier' ? structs.get(node.name) : node;
  if (!isSchemaCall(struct, 'Struct') || struct.arguments[0]?.type !== 'ObjectExpression') return undefined;
  return struct.arguments[0].properties
    .filter(p => p.type === 'Property' && (isSchemaCall(p.value, 'Literal') || isSchemaCall(p.value, 'Literals')))
    .map(p => p.key.name);
};

const isMixedTagUnion = (node, structs) => {
  if (!isSchemaCall(node, 'Union') || node.arguments[0]?.type !== 'ArrayExpression') return false;
  const tags = node.arguments[0].elements.map(member => findStructTags(member, structs));
  if (tags.length < 2 || tags.some(t => t === undefined) || tags.every(t => t.length === 0)) return false;
  return !tags[0].some(key => tags.every(t => t.includes(key)));
};

const gathers = /\b(readFileSync|execFileSync|readCheckInputFiles)\(|Text\(/;
const bounded = /slice\(|clip|max|limit/i;

/** Fields of the items a script prints that gather text with no clip or limit, in their value or its declaration. */
const unbounded = (program, text, getLineAt) => {
  const getNodeCode = node => text.slice(node.start, node.end);
  const declared = new Map();
  walk(program, node => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') declared.set(node.id.name, getNodeCode(node));
  });
  const found = [];
  walk(program, node => {
    const [item] = node.type === 'CallExpression' && getNodeCode(node.callee) === 'console.log' ? node.arguments : [];
    if (item?.type !== 'CallExpression' || getNodeCode(item.callee) !== 'JSON.stringify') return;
    walk(item.arguments[0], field => {
      if (field.type !== 'Property' || field.value.type === 'ObjectExpression') return;
      const texts = [getNodeCode(field.value)];
      walk(field.value, (name, parents) => {
        const parent = parents.at(-1);
        const property = parent?.type === 'MemberExpression' && parent.property === name && !parent.computed;
        if (name.type === 'Identifier' && !property) texts.push(declared.get(name.name) ?? '');
      });
      if (texts.some(code => gathers.test(code)) && !texts.some(code => bounded.test(code))) found.push(getLineAt(field.start));
    });
  });
  return found;
};

const { findings, add } = reporter();
const hinted = reporter();
for (const source of readCheckInputFiles(path => code(path) || slicer(path))) {
  const { path, text } = source;
  const { program, error } = parseSourceFileToAst(path, text);
  const getLineAt = makeOffsetToLineLookup(text);
  if (error) {
    add({ ...source, lines: undefined }, 1, `does not parse: ${error}`);
    continue;
  }

  if (studioFile(path)) studioUi(source, program, getLineAt, add);
  if (slicer(path)) {
    for (const line of unbounded(program, text, getLineAt)) add(source, line, 'a field sent to a model with no clip or limit');
    continue;
  }

  if (entries.has(path)) {
    for (const node of valueImports(program)) {
      const specifier = node.source.value;
      if (/(View\.tsx|\/lab\/)/.test(specifier)) {
        add(source, getLineAt(node.start), `imports ${specifier} eagerly; load a route with lazy(() => import(...))`);
      }
    }
  }

  const structs = new Map();
  walk(program, node => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') structs.set(node.id.name, node.init);
  });
  walk(program, (node, parents) => {
    const line = getLineAt(node.start);
    const inFunction = parents.some(p => functions.has(p.type));
    if (node.type === 'VariableDeclarator' && inFunction && /^[A-Z]/.test(node.id?.name ?? '')) {
      const init = node.init;
      const component =
        (init && functions.has(init.type) && hasJsx(init.body)) ||
        (init?.type === 'CallExpression' && wrappers.has(calleeName(init)));
      if (component) add(source, line, `component ${node.id.name} defined inside a function; move it to module level`);
    }
    if (node.type === 'FunctionDeclaration' && inFunction && /^[A-Z]/.test(node.id?.name ?? '')) {
      add(source, line, `component ${node.id.name} defined inside a function; move it to module level`);
    }
    if (isMixedTagUnion(node, structs))
      add(source, line, 'a union whose members share no tag key; tag every member with the same key');
    if (node.type === 'CallExpression' && node.callee.name === 'useEffect') {
      const body = node.arguments[0]?.body;
      const statements = body?.type === 'BlockStatement' ? body.body.map(s => s.expression) : [body];
      const setsOnly =
        statements.length > 0 &&
        statements.every(s => s?.type === 'CallExpression' && /^set[A-Z]/.test(s.callee.name ?? ''));
      if (setsOnly) hinted.add(source, line, 'hint: an effect that only sets state; derive the value while rendering');
    }
  });
}
for (const hint of hinted.findings) console.log(hint);
report('code-shape', findings);
