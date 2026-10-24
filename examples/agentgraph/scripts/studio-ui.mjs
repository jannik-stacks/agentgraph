// The studio's UI rules on TSX under studio/src: shared primitives instead of native controls, icons explained by a
// tooltip, numbers before their muted arrows, one kind of spinner per level, motion only for new items, and nothing
// that flashes while it loads. code-shape runs them.
import { getJsxAttr, attrText, isNative, meaningful, getJsxTag, walk } from './ast.mjs';

export const studioFile = path => /^studio\/src\/.*\.tsx$/.test(path) && !path.startsWith('studio/src/lab/');
const primitives = path => path === 'studio/src/ui.tsx';
const statusDrawing = path =>
  path === 'studio/src/icons.tsx' || path === 'studio/src/dashboard/bits.tsx' || path === 'studio/src/studio/icons.tsx';
const markdownHome = path =>
  path === 'studio/src/Markdown.tsx' || /^studio\/src\/(docs|code|source)\//.test(path);

const interactive = new Set(['button', 'a', 'summary']);
const isIcon = tag => tag === 'Icon' || tag === 'svg' || tag.endsWith('Icon');
const arrowIcon = /^(in|out|up|down|arrow[-\w]*|[-\w]*-arrow)$/;
const loud = /\banimate-(spin|pulse|ping|bounce)\b/;
const entering = /\b(agi-enter|animate-in|fade-in|slide-in[-\w]*|zoom-in|animate-\[)/;
const markdownLibraries = /^(fumadocs-core\/highlight|shiki|react-markdown|marked|markdown-it|remark[-\w]*|rehype[-\w]*)$/;

const textOf = node => {
  let text = '';
  walk(node, child => {
    if (child.type === 'JSXText') text += child.value;
    else if (child.type === 'Literal' && typeof child.value === 'string') text += child.value;
    else if (child.type === 'TemplateElement') text += child.value.cooked ?? child.value.raw;
  });
  return text;
};

const rendered = expression => {
  if (!expression) return undefined;
  if (expression.type === 'JSXElement') return expression;
  if (expression.type === 'LogicalExpression') return rendered(expression.right);
  if (expression.type === 'ConditionalExpression') return rendered(expression.consequent) ?? rendered(expression.alternate);
  return undefined;
};
const elementOf = child =>
  child.type === 'JSXElement' ? child : child.type === 'JSXExpressionContainer' ? rendered(child.expression) : undefined;

const inList = parents =>
  parents.some(p => p.type === 'CallExpression' && p.callee.type === 'MemberExpression' && p.callee.property.name === 'map');

const isTilde = text => /^\s*[~≈]\s*$/.test(text) || /[~≈]\s*\$/.test(text);

/** Reports every studio UI rule a source breaks through `add(source, line, message)`. */
export const studioUi = (source, program, lineOf, add) => {
  const { path, code } = source;
  walk(program, (node, parents) => {
    const line = lineOf(node.start);

    if (node.type === 'ImportDeclaration' && !markdownHome(path) && markdownLibraries.test(node.source.value)) {
      add(source, line, `imports ${node.source.value}; render markdown and code through the shared Markdown component`);
    }
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'lazy' &&
      /Markdown/.test(code.slice(node.start, node.end))
    ) {
      add(source, line, 'Markdown loaded lazily; it flashes in when it arrives, so import it statically');
    }

    if ((node.type === 'Literal' && typeof node.value === 'string') || node.type === 'TemplateElement') {
      const text = node.type === 'Literal' ? node.value : (node.value.cooked ?? node.value.raw);
      if (!statusDrawing(path) && loud.test(text)) {
        add(source, line, `${loud.exec(text)[0]} outside the status icons; use StatusIcon with its level`);
      }
      if (entering.test(text) && inList(parents) && !code.includes('useEnter(')) {
        add(source, line, `enter animation "${entering.exec(text)[0]}" on every row of a list; animate only new rows, with useEnter`);
      }
      if (isTilde(text) && parents.some(p => p.type === 'JSXElement' || p.type === 'JSXExpressionContainer')) {
        add(source, line, 'a tilde on a value; show the rounded number and put the exact one in a tooltip');
      }
    }
    if (node.type === 'JSXText' && isTilde(node.value)) {
      add(source, line, 'a tilde on a value; show the rounded number and put the exact one in a tooltip');
    }

    if (node.type === 'JSXAttribute' && node.name?.name === 'fallback' && /loading/i.test(textOf(node.value))) {
      add(source, line, 'a "Loading" fallback; keep the space with a sized placeholder and no text');
    }

    if (node.type !== 'JSXElement') return;
    const tag = getJsxTag(node);

    if (tag === 'select' && !primitives(path)) {
      add(source, line, 'a native <select>; use Select from ui.tsx, which spaces its chevron from the text');
    }
    if (isNative(tag) && tag !== 'iframe' && getJsxAttr(node, 'title') && !primitives(path)) {
      add(source, line, `a native title on <${tag}>; wrap it in Tooltip`);
    }

    const children = meaningful(node.children);
    const kids = children.map(elementOf);

    const clickable = interactive.has(tag) || getJsxAttr(node, 'onClick') || attrText(getJsxAttr(node, 'role')) === 'button';
    if (isNative(tag) && clickable && !primitives(path)) {
      const iconOnly =
        kids.some(kid => kid && isIcon(getJsxTag(kid))) && kids.every(kid => kid && (isIcon(getJsxTag(kid)) || getJsxTag(kid) === 'Num'));
      const tipped = parents.some(p => p.type === 'JSXElement' && getJsxTag(p) === 'Tooltip');
      if (iconOnly && !tipped) add(source, line, `<${tag}> shows only an icon; wrap it in Tooltip to say what it does`);
    }

    kids.forEach((kid, i) => {
      if (!kid) return;
      const kidTag = getJsxTag(kid);
      const number = child =>
        child && ((child.type === 'JSXExpressionContainer' && !elementOf(child)) || getJsxTag(elementOf(child) ?? {}) === 'Num');
      if (
        isIcon(kidTag) &&
        arrowIcon.test(attrText(getJsxAttr(kid, 'name')) ?? '') &&
        number(children[i + 1]) &&
        !number(children[i - 1])
      ) {
        add(source, lineOf(kid.start), 'an arrow before its number; put the number first and the muted arrow after it');
      }
      const before = kids[i - 1];
      const removes =
        kidTag === 'button' &&
        (/^\s*[×✕x]\s*$/i.test(textOf(kid)) || /remove/i.test(attrText(getJsxAttr(kid, 'aria-label')) ?? ''));
      if (removes && before && /^(Chip|Badge)$/.test(getJsxTag(before)) && !primitives(path)) {
        add(source, lineOf(kid.start), 'a remove button beside a chip; use RemovableChip, which keeps it inside the border');
      }
    });
  });
};
