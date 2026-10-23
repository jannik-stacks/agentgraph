// Checks that box-drawing and ASCII diagrams in fenced blocks of docs/*.md and README.md line up, in display columns.
// Usage: node bin/diagrams.mjs [file.md ...]
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dirname, '..');
const BOX = /[┌┐└┘│─├┤┬┴┼]/;
const ASCII_BOX = /\+-{2,}\+/;
const down = new Set('│├┤┬┼┌┐|+▲↑^'); // chars above a vertical that continue into it
const up = new Set('│├┤┴┼└┘|+▼↓v'); // chars below a vertical that it continues into
const right = new Set('─┌└├┬┴┼'); // chars with a stub to their right
const left = new Set('─┐┘┤┬┴┼'); // chars with a stub to their left
const wide = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
  [0x20000, 0x3fffd],
];
const segmenter = new Intl.Segmenter();

const width = g => {
  const cp = g.codePointAt(0);
  if (g.includes('️') || wide.some(([a, b]) => cp >= a && cp <= b)) return 2;
  return /^[\p{M}\p{Cf}]$/u.test(g) ? 0 : 1;
};

/** One char per display column; a wide char holds its column and leaves the next one empty. */
const cells = line => {
  const out = [];
  for (const { segment } of segmenter.segment(line)) {
    const w = width(segment);
    if (w === 0) continue;
    out.push(segment);
    if (w === 2) out.push('');
  }
  return out;
};

/** Returns the `{ line, col, message }` problems of the fenced diagrams in markdown `text`, and the diagram count. */
function checkDiagrams(text) {
  const problems = [];
  let diagrams = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*```/.test(lines[i])) continue;
    let end = i + 1;
    while (end < lines.length && !/^\s*```/.test(lines[end])) end++;
    const block = lines.slice(i + 1, end);
    const unicode = block.some(l => BOX.test(l));
    if (unicode || block.some(l => ASCII_BOX.test(l))) {
      diagrams++;
      for (const p of checkBlock(block, unicode)) problems.push({ ...p, line: p.line + i + 1 });
    }
    i = end;
  }
  return { problems, diagrams };
}

function checkBlock(block, unicode) {
  const grid = block.map(cells);
  const at = (r, c) => grid[r]?.[c] || ' ';
  const out = [];
  const report = (r, c, message) => out.push({ line: r + 1, col: c + 1, message });
  const pipe = unicode ? '│' : '|';

  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      const ch = grid[r][c];
      if (ch === pipe) {
        if (!down.has(at(r - 1, c)) && !up.has(at(r + 1, c))) {
          const near = [c - 1, c + 1].find(n => down.has(at(r - 1, n)) || up.has(at(r + 1, n)));
          report(
            r,
            c,
            near === undefined
              ? `${pipe} has no vertical connector above or below`
              : `${pipe} is off by one column from the connector at col ${near + 1}`
          );
        }
      } else if (unicode) {
        const above = down.has(at(r - 1, c));
        const below = up.has(at(r + 1, c));
        const need = (ok, what) => ok || report(r, c, `${ch} ${what}`);
        if (ch === '┌') need(below && left.has(at(r, c + 1)), 'needs ─ to its right and │ below');
        if (ch === '┐') need(below && right.has(at(r, c - 1)), 'needs ─ to its left and │ below');
        if (ch === '└') need(above && left.has(at(r, c + 1)), 'needs ─ to its right and │ above');
        if (ch === '┘') need(above && right.has(at(r, c - 1)), 'needs ─ to its left and │ above');
        if (ch === '├') need((above || below) && left.has(at(r, c + 1)), 'needs a vertical and ─ to its right');
        if (ch === '┤') need((above || below) && right.has(at(r, c - 1)), 'needs a vertical and ─ to its left');
      }
    }
  }
  if (!unicode) return out;

  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      if (grid[r][c] !== '┌') continue;
      let c2 = c + 1;
      while ('─┬┴┼'.includes(at(r, c2)) && c2 < grid[r].length) c2++;
      if (at(r, c2) !== '┐') {
        report(r, c, `top edge from ┌ does not end in ┐ (stops at col ${c2 + 1})`);
        continue;
      }
      let r2 = r + 1;
      while (r2 < grid.length && '│├┤┼'.includes(at(r2, c))) r2++;
      if (at(r2, c) !== '└') {
        report(r2, c, `left edge of box at ${r + 1}:${c + 1} does not end in └`);
        continue;
      }
      let c3 = c + 1;
      while ('─┬┴┼'.includes(at(r2, c3)) && c3 < grid[r2].length) c3++;
      if (at(r2, c3) !== '┘')
        report(r2, c3, `bottom edge does not end in ┘ (box at ${r + 1}:${c + 1} has its right edge at col ${c2 + 1})`);
      else if (c3 !== c2) report(r2, c3, `bottom right corner at col ${c3 + 1}, top right corner at col ${c2 + 1}`);
      for (let m = r + 1; m < r2; m++) {
        if (!'│┤├┼'.includes(at(m, c2))) {
          const off = [c2 - 1, c2 + 1].find(n => at(m, n) === '│');
          report(
            m,
            c2,
            off === undefined
              ? `box at ${r + 1}:${c + 1} has no right edge here`
              : `right edge of box at ${r + 1}:${c + 1} is off by one column (│ at col ${off + 1}, expected ${c2 + 1})`
          );
        }
      }
    }
  }
  return out;
}

if (process.argv[1] === import.meta.filename) {
  const docs = join(root, 'docs');
  const files =
    process.argv.length > 2
      ? process.argv.slice(2)
      : [
          ...readdirSync(docs)
            .filter(f => f.endsWith('.md'))
            .map(f => join(docs, f)),
          join(root, 'README.md'),
        ];
  let total = 0;
  let bad = 0;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const { problems, diagrams } = checkDiagrams(text);
    total += diagrams;
    for (const p of problems) {
      bad++;
      console.log(`${relative(root, file)}:${p.line}:${p.col}: ${p.message}`);
    }
  }
  if (bad) process.exit(1);
  console.log(`${total} diagrams ok`);
}
