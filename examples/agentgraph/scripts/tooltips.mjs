// One JSON line per tooltip a change adds under studio/src, with the element it explains, so a small model can judge
// whether the text says what the thing is or does.
import { getJsxAttr, attrText, makeOffsetToLineLookup, parseSourceFileToAst, getJsxTag, walk } from './ast.mjs';
import { readCheckInputFiles } from './changes.mjs';

const studio = path => /^studio\/src\/.*\.tsx$/.test(path) && !path.startsWith('studio/src/lab/');

for (const source of readCheckInputFiles(studio)) {
  const { path, text: code } = source;
  const { program } = parseSourceFileToAst(path, code);
  if (!program) continue;
  const getLineAt = makeOffsetToLineLookup(code);
  walk(program, node => {
    if (node.type !== 'JSXElement') return;
    const tip = getJsxAttr(node, 'tip');
    if (!tip) return;
    const line = getLineAt(node.start);
    if (!source.lines.some(l => l.line === line || l.line === getLineAt(tip.start))) return;
    const text = attrText(tip) ?? code.slice(tip.value.start, tip.value.end);
    console.log(
      JSON.stringify({ file: path, line, element: getJsxTag(node), tip: text, code: code.slice(node.start, node.end).slice(0, 600) })
    );
  });
}
