// Structure rules on the TypeScript a change adds under src/ and studio/src: components defined at module level,
// routes loaded lazily, schema unions told apart by `type`, and the studio's UI rules on its TSX. Softer hints, state
// copied in an effect and type unions told apart by another field, are printed without failing the check. In the hub
// scripts, a field an item sends to a model that gathers text with no clip or limit fails.
import { lineIndex, parse, reporter, sources, walk } from './ast.mjs';
import { report } from './changes.mjs';
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

const gathers = /\b(readFileSync|execFileSync|sources)\(|Text\(/;
const bounded = /slice\(|clip|max|limit/i;

/** Fields of the items a script prints that gather text with no clip or limit, in their value or its declaration. */
const unbounded = (program, text, lineOf) => {
  const codeOf = node => text.slice(node.start, node.end);
  const declared = new Map();
  walk(program, node => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') declared.set(node.id.name, codeOf(node));
  });
  const found = [];
  walk(program, node => {
    const [item] = node.type === 'CallExpression' && codeOf(node.callee) === 'console.log' ? node.arguments : [];
    if (item?.type !== 'CallExpression' || codeOf(item.callee) !== 'JSON.stringify') return;
    walk(item.arguments[0], field => {
      if (field.type !== 'Property' || field.value.type === 'ObjectExpression') return;
      const texts = [codeOf(field.value)];
      walk(field.value, (name, parents) => {
        const parent = parents.at(-1);
        const property = parent?.type === 'MemberExpression' && parent.property === name && !parent.computed;
        if (name.type === 'Identifier' && !property) texts.push(declared.get(name.name) ?? '');
      });
      if (texts.some(code => gathers.test(code)) && !texts.some(code => bounded.test(code))) found.push(lineOf(field.start));
    });
  });
  return found;
};

const { findings, add } = reporter();
const hinted = reporter();
for (const source of sources(path => code(path) || slicer(path))) {
  const { path, code: text } = source;
  const { program, error } = parse(path, text);
  const lineOf = lineIndex(text);
  if (error) {
    add({ ...source, lines: null }, 1, `does not parse: ${error}`);
    continue;
  }

  if (studioFile(path)) studioUi(source, program, lineOf, add);
  if (slicer(path)) {
    for (const line of unbounded(program, text, lineOf)) add(source, line, 'a field sent to a model with no clip or limit');
    continue;
  }

  if (entries.has(path)) {
    for (const node of valueImports(program)) {
      const specifier = node.source.value;
      if (/(View\.tsx|\/lab\/)/.test(specifier)) {
        add(source, lineOf(node.start), `imports ${specifier} eagerly; load a route with lazy(() => import(...))`);
      }
    }
  }

  walk(program, (node, parents) => {
    const line = lineOf(node.start);
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
    if (node.type === 'CallExpression' && calleeName(node) === 'discriminatedUnion') {
      const key = node.arguments[0];
      if (key?.type === 'Literal' && key.value !== 'type') {
        add(source, line, `a union told apart by "${key.value}"; use "type"`);
      }
    }

    if (
      node.type === 'TSPropertySignature' &&
      !node.computed &&
      ['kind', 'tag', 'variant'].includes(node.key?.name) &&
      node.typeAnnotation?.typeAnnotation?.type === 'TSLiteralType' &&
      parents.at(-2)?.type === 'TSUnionType'
    ) {
      hinted.add(source, line, `hint: a union told apart by "${node.key.name}"; prefer "type"`);
    }
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
