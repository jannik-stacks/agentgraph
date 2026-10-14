// Deterministic metrics comparing candidate diff A (bothub) with B (the merged change), both against the checkout in
// --repo.
//   node bench/compare.mjs --repo DIR --a A.diff --b B.diff [--followups f.json] [--tests-a CMD] [--tests-b CMD]
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { lineIndex, parse, walk } from '../examples/bothub/scripts/ast.mjs';
import { fileDiffs } from '../src/over.ts';

const round = n => Math.round(n * 1000) / 1000;
const ratio = (a, b) => (b ? round(a / b) : null);
const jaccard = (a, b) => {
  const union = new Set([...a, ...b]);
  return union.size ? round([...a].filter(x => b.has(x)).length / union.size) : 1;
};
const minus = (a, b) => [...a].filter(x => !b.has(x)).sort();

/** Files of a unified diff with each hunk's added and removed lines and their line numbers. */
export const parseDiff = text =>
  fileDiffs(text).map(({ label, text: part }) => {
    const file = { path: label, hunks: [] };
    let hunk;
    let o = 0;
    let n = 0;
    for (const line of part.split('\n')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m) {
        o = +m[1];
        n = +m[3];
        hunk = { oldStart: o, oldLen: m[2] === undefined ? 1 : +m[2], added: [], removed: [], anchors: [] };
        file.hunks.push(hunk);
      } else if (!hunk) continue;
      else if (line.startsWith('+')) {
        hunk.added.push({ line: n++, text: line.slice(1) });
        hunk.anchors.push(o - 1);
      } else if (line.startsWith('-')) hunk.removed.push({ line: o++, text: line.slice(1) });
      else if (line.startsWith(' ')) {
        o++;
        n++;
      }
    }
    return file;
  });

export const kindOf = path =>
  /(^|\/)(tests?|__tests__|spec)\//.test(path) || /\.(test|spec)\.\w+$|_test\.\w+$/.test(path)
    ? 'tests'
    : /\.mdx?$|(^|\/)docs?\//.test(path) && !/(^|\/)(workflows|skills|prompts)\//.test(path)
      ? 'docs'
      : 'src';
const isRust = path => path.endsWith('.rs');
const isCode = path => /\.(m?[jt]sx?|rs|py|go)$/.test(path);
const addedOf = file => file.hunks.flatMap(h => h.added);
const removedOf = file => file.hunks.flatMap(h => h.removed);

const size = files => {
  const out = {
    added: 0,
    removed: 0,
    files: files.length,
    src: 0,
    srcAdded: 0,
    srcNonBlank: 0,
    tests: 0,
    testsAdded: 0,
    docs: 0,
  };
  for (const f of files) {
    const a = addedOf(f).length;
    const r = removedOf(f).length;
    out.added += a;
    out.removed += r;
    out[kindOf(f.path)] += a + r;
    if (kindOf(f.path) === 'src') out.srcAdded += a;
    if (kindOf(f.path) === 'tests') out.testsAdded += a;
    if (kindOf(f.path) === 'src') out.srcNonBlank += [...addedOf(f), ...removedOf(f)].filter(l => l.text.trim()).length;
  }
  return out;
};

const sizeMetric = (a, b) => {
  const [sa, sb] = [size(a), size(b)];
  const total = s => s.added + s.removed;
  return {
    a: sa,
    b: sb,
    ratio: {
      total: ratio(total(sa), total(sb)),
      src: ratio(sa.src, sb.src),
      srcAdded: ratio(sa.srcAdded, sb.srcAdded),
      srcNonBlank: ratio(sa.srcNonBlank, sb.srcNonBlank),
      tests: ratio(sa.tests, sb.tests),
    },
  };
};

const baseText = (repo, path) => {
  const full = join(repo, path);
  return existsSync(full) ? readFileSync(full, 'utf8') : undefined;
};

/** The text of each touched file after the diff applies, via git apply in a scratch directory. */
const applied = (repo, diffText, files) => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-apply-'));
  try {
    for (const f of files) {
      const text = baseText(repo, f.path);
      if (text === undefined) continue;
      mkdirSync(dirname(join(dir, f.path)), { recursive: true });
      writeFileSync(join(dir, f.path), text);
    }
    writeFileSync(join(dir, 'change.diff'), diffText);
    spawnSync('git', ['apply', '--unsafe-paths', 'change.diff'], { cwd: dir, encoding: 'utf8' });
    const texts = new Map(files.map(f => [f.path, baseText(dir, f.path)]));
    return path => texts.get(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const rustDecl =
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+|unsafe\s+|const\s+)*(fn|struct|enum|trait|impl|mod)\s+([\w:<>]+)/;

/** Name of the innermost declaration around each line: TS and JS from the AST, Rust from declaration regexes. */
export const symbolsAt = (path, code, lines) => {
  if (code === undefined || !lines.length) return [];
  if (isRust(path)) {
    const rows = code.split('\n');
    return lines.map(line => {
      for (let i = Math.min(line, rows.length) - 1; i >= 0; i--) {
        const m = rustDecl.exec(rows[i]);
        if (m) return `${m[1]} ${m[2]}`;
      }
      return '(top)';
    });
  }
  if (!/\.m?[jt]sx?$/.test(path)) return [];
  const { program, error } = parse(path, code);
  if (error) return [];
  const at = lineIndex(code);
  const named = [];
  const fnLike = n => n && /Function|Arrow/.test(n.type);
  const declared =
    /^(TSInterfaceDeclaration|TSTypeAliasDeclaration|TSEnumDeclaration|FunctionDeclaration|ClassDeclaration)$/;
  walk(program, (node, parents) => {
    let name;
    if (declared.test(node.type)) name = node.id?.name;
    else if (node.type === 'MethodDefinition' || node.type === 'PropertyDefinition') name = node.key?.name;
    else if (
      node.type === 'VariableDeclarator' &&
      node.id?.type === 'Identifier' &&
      (fnLike(node.init) || parents.every(p => /Program|ExportNamedDeclaration|VariableDeclaration/.test(p.type)))
    )
      name = node.id.name;
    if (name) named.push({ name, from: at(node.start), to: at(node.end), depth: parents.length });
  });
  return lines.map(line => {
    const inside = named.filter(s => s.from <= line && line <= s.to).sort((x, y) => y.depth - x.depth);
    return inside[0]?.name ?? '(top)';
  });
};

/** `path::symbol` keys of every symbol a diff touches: added lines in the new text, removed lines in the base text. */
const symbolSet = (repo, diffText, files) => {
  const after = applied(repo, diffText, files);
  const out = new Set();
  const code = (path, lines) => lines.filter(l => l.text.trim() && !commentOf(path, l.text)).map(l => l.line);
  for (const f of files) {
    if (!isCode(f.path)) continue;
    const found = [
      ...symbolsAt(f.path, baseText(repo, f.path), code(f.path, removedOf(f))),
      ...symbolsAt(f.path, after(f.path), code(f.path, addedOf(f))),
    ];
    for (const s of found) if (s !== '(top)') out.add(`${f.path}::${s}`);
  }
  return out;
};

/** `path:line` keys in base coordinates: removed lines, and the line before each insertion. */
const touchKeys = files =>
  new Set(
    files.flatMap(f => f.hunks.flatMap(h => [...h.removed.map(l => l.line), ...h.anchors].map(l => `${f.path}:${l}`)))
  );

const overlapMetric = (a, b, sa, sb) => {
  const [ta, tb] = [touchKeys(a), touchKeys(b)];
  return {
    fileJaccard: jaccard(new Set(a.map(f => f.path)), new Set(b.map(f => f.path))),
    symbolJaccard: jaccard(sa, sb),
    bLinesTouchedByA: tb.size ? round([...tb].filter(k => ta.has(k)).length / tb.size) : null,
  };
};

const creepMetric = (a, b, sa, sb) => {
  const [fa, fb] = [new Set(a.map(f => f.path)), new Set(b.map(f => f.path))];
  return {
    extraFiles: minus(fa, fb),
    missedFiles: minus(fb, fa),
    extraSymbols: minus(sa, sb),
    missedSymbols: minus(sb, sa),
  };
};

const caseStart = /^\s*(?:(?:it|test)(?:\.\w+)*\s*\(|#\[(?:tokio::)?test\]|def test_|func Test)/;
const titleOf = line => /^\s*(?:it|test)(?:\.\w+)*\s*\(\s*(['"`])(.*?)\1/.exec(line)?.[2] ?? '';
const assertion = /\bexpect\s*\(|\bassert(?:_eq|_ne)?!?\s*[.(]|\bassert!/;

const tautology = (line, constants) => {
  const t = line.trim();
  let m;
  if (/\bassert!\(\s*true\s*[,)]/.test(t) || /\bassert\(\s*true\s*\)/.test(t)) return true;
  if ((m = /assert_eq!\(\s*([^,]+?)\s*,\s*(.+?)\s*\)\s*;?$/.exec(t))) return m[1] === m[2];
  if ((m = /assert\.(?:equal|strictEqual|deepEqual|deepStrictEqual)\(\s*(.+?)\s*,\s*(.+?)\s*\)\s*;?$/.exec(t)))
    return m[1] === m[2];
  if ((m = /expect\((.+)\)\.(?:toBe|toEqual|toStrictEqual)\((.+)\)\s*;?$/.exec(t)))
    return m[1] === m[2] || constants.get(m[1]) === m[2];
  return false;
};

const testStats = files => {
  const out = { cases: 0, assertions: 0, assertionsPerCase: null, tautologies: 0, still: 0 };
  for (const f of files) {
    if (!isCode(f.path) || (kindOf(f.path) !== 'tests' && !isRust(f.path))) continue;
    const lines = addedOf(f).map(l => l.text);
    const constants = new Map();
    for (const text of lines) {
      const c = /^\s*(?:const|let)\s+(\w+)\s*=\s*(.+?);?\s*$/.exec(text);
      if (c) constants.set(c[1], c[2]);
    }
    for (const text of lines) {
      if (caseStart.test(text)) {
        out.cases++;
        if (/\bstill\b/i.test(titleOf(text))) out.still++;
      }
      if (assertion.test(text)) {
        out.assertions++;
        if (tautology(text, constants)) out.tautologies++;
      }
    }
  }
  out.assertionsPerCase = ratio(out.assertions, out.cases);
  return out;
};

const commentOf = (path, text) => {
  const t = text.trim();
  if (/^(\/\/|\/\*|\*)/.test(t)) return t;
  return /\.(py)$/.test(path) && t.startsWith('#') ? t : undefined;
};
const history = /\b(was|now|previously|renamed|fixed|round|TODO|used to|no longer)\b/i;
const stripStrings = s => s.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""');
const risky = (path, text) => {
  const code = stripStrings(text);
  if (isRust(path)) return /\.unwrap\(\)|\.expect\(|\bpanic!\(/.test(code);
  return /\bas any\b|[\w)\]]!(?=[.[);,]|$)/.test(code);
};

const depLine = (path, text) => {
  if (path.endsWith('package.json')) {
    const m = /^\s*"([^"]+)":\s*"[\^~<>=*\d][^"]*",?\s*$/.exec(text);
    return m && m[1] !== 'version' ? m[1] : undefined;
  }
  if (path.endsWith('Cargo.toml')) {
    const m = /^\s*([\w-]+)\s*=\s*(?:"[\d^~=<>*]|\{.*version)/.exec(text);
    return m && !['version', 'edition', 'rust-version'].includes(m[1]) ? m[1] : undefined;
  }
  return undefined;
};

const declaredNames = text =>
  [...text.matchAll(/\b(?:const|let|var|function|fn|def|type|interface|struct)\s+([A-Za-z_]\w*)/g)].map(m => m[1]);

const styleStats = files => {
  const out = {
    commentLines: 0,
    codeLines: 0,
    commentDensity: 0,
    historyComments: [],
    risky: 0,
    newDependencies: [],
    naming: { snake: 0, camel: 0, mixed: false },
  };
  for (const f of files) {
    if (kindOf(f.path) === 'docs') continue;
    for (const { text } of addedOf(f)) {
      const dep = depLine(f.path, text);
      if (dep) out.newDependencies.push(dep);
      if (!isCode(f.path) || !text.trim()) continue;
      const comment = commentOf(f.path, text);
      if (comment) {
        out.commentLines++;
        if (history.test(comment)) out.historyComments.push(comment.slice(0, 100));
        continue;
      }
      out.codeLines++;
      if (kindOf(f.path) === 'src' && risky(f.path, text)) out.risky++;
      for (const name of declaredNames(text)) {
        if (/^[A-Z0-9_]+$/.test(name)) continue;
        if (name.includes('_')) out.naming.snake++;
        else if (/[a-z][A-Z]/.test(name)) out.naming.camel++;
      }
    }
  }
  out.commentDensity = ratio(out.commentLines, out.codeLines) ?? 0;
  out.naming.mixed = out.naming.snake > 0 && out.naming.camel > 0;
  return out;
};

const styleMetric = (a, b) => {
  const [x, y] = [styleStats(a), styleStats(b)];
  return { a: x, b: y, commentDensityRatio: ratio(x.commentDensity, y.commentDensity) };
};

/** Base-side line range of a merged-side line: shifted by B's earlier hunks, or the hunk's own range when inside one. */
const toBase = (bFiles, path, line) => {
  let shift = 0;
  for (const h of bFiles.find(f => f.path === path)?.hunks ?? []) {
    const newLen = h.added.length + (h.oldLen - h.removed.length);
    const newStart = h.oldStart + shift;
    if (line < newStart) break;
    if (line < newStart + newLen) return [h.oldStart, h.oldStart + Math.max(h.oldLen - 1, 0)];
    shift += newLen - h.oldLen;
  }
  return [line - shift, line - shift];
};

const followupMetric = (followups, aFiles, bFiles) => {
  const hunks = followups.flatMap(c => (c.hunks ?? []).map(h => ({ ...h, commit: c.commit })));
  const results = hunks.map(h => {
    const from = toBase(bFiles, h.file, h.start)[0];
    const to = toBase(bFiles, h.file, h.end)[1];
    const aTouches = aFiles
      .filter(f => f.path === h.file)
      .some(f =>
        f.hunks.some(
          x => x.removed.some(l => l.line >= from && l.line <= to) || x.anchors.some(l => l >= from - 1 && l <= to)
        )
      );
    return { commit: h.commit?.slice(0, 10), file: h.file, baseLines: [from, to], aTouches };
  });
  return { hunks: results.length, aCaught: results.filter(r => r.aTouches).length, results };
};

/** Runs `cmd` in a scratch copy of `repo` with the diff applied. */
export const runTests = (repo, diffText, cmd) => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-tests-'));
  try {
    cpSync(repo, dir, { recursive: true, filter: src => !/(^|\/)(node_modules|target|\.git)$/.test(src) });
    if (existsSync(join(repo, 'node_modules'))) symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'));
    writeFileSync(join(dir, 'change.diff'), diffText);
    const patch = spawnSync('git', ['apply', '--unsafe-paths', 'change.diff'], { cwd: dir, encoding: 'utf8' });
    if (patch.status !== 0) return { applied: false, error: patch.stderr.slice(0, 300) };
    const run = spawnSync('sh', ['-c', cmd], { cwd: dir, encoding: 'utf8', timeout: 600000 });
    return { applied: true, exit: run.status, ok: run.status === 0, tail: (run.stdout + run.stderr).slice(-300) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Compares diff texts `a` and `b` against the checkout in `repo`. */
export const compare = ({ repo, a: da, b: db, followups, testsA, testsB }) => {
  const [fa, fb] = [parseDiff(da), parseDiff(db)];
  const [sa, sb] = [symbolSet(repo, da, fa), symbolSet(repo, db, fb)];
  const out = {
    size: sizeMetric(fa, fb),
    overlap: overlapMetric(fa, fb, sa, sb),
    scopeCreep: creepMetric(fa, fb, sa, sb),
    tests: { a: testStats(fa), b: testStats(fb) },
    style: styleMetric(fa, fb),
  };
  if (followups) out.followups = followupMetric(followups, fa, fb);
  if (testsA || testsB)
    out.testRuns = { a: testsA && runTests(repo, da, testsA), b: testsB && runTests(repo, db, testsB) };
  return out;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string' },
      a: { type: 'string' },
      b: { type: 'string' },
      followups: { type: 'string' },
      'tests-a': { type: 'string' },
      'tests-b': { type: 'string' },
    },
  });
  if (!values.repo || !values.a || !values.b) throw new Error('usage: compare.mjs --repo DIR --a A.diff --b B.diff');
  const read = file => file && readFileSync(file, 'utf8');
  const { repo, a, b, followups } = values;
  const tests = { testsA: values['tests-a'], testsB: values['tests-b'] };
  const mined = followups && JSON.parse(read(followups));
  console.log(JSON.stringify(compare({ repo, a: read(a), b: read(b), followups: mined, ...tests }), null, 2));
}
