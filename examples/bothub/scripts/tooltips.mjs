// One JSON line per tooltip a change adds under studio/src, with the element it explains, so a small model can judge
// whether the text says what the thing is or does.
import { attrOf, attrText, lineIndex, parse, sources, tagOf, walk } from './ast.mjs';

const studio = path => /^studio\/src\/.*\.tsx$/.test(path) && !path.startsWith('studio/src/lab/');

for (const source of sources(studio)) {
  const { path, code } = source;
  const { program } = parse(path, code);
  if (!program) continue;
  const lineOf = lineIndex(code);
  walk(program, node => {
    if (node.type !== 'JSXElement') return;
    const tip = attrOf(node, 'tip');
    if (!tip) return;
    const line = lineOf(node.start);
    if (source.lines && !source.lines.has(line) && !source.lines.has(lineOf(tip.start))) return;
    const text = attrText(tip) ?? code.slice(tip.value.start, tip.value.end);
    console.log(
      JSON.stringify({ file: path, line, element: tagOf(node), tip: text, code: code.slice(node.start, node.end).slice(0, 600) })
    );
  });
}
