import { existsSync, readFileSync } from 'node:fs';
import { readEnvBaseSha, changeText } from './changes.mjs';

const declared = [['run status', 'src/workflow.ts', /\bstatus: ([^;]+);/]];
const context = 12;
const maxChars = 12_000;

const values = declared.flatMap(([kind, path, pattern]) => {
  const list = existsSync(path) ? pattern.exec(readFileSync(path, 'utf8'))?.[1] : undefined;
  return [...(list ?? '').matchAll(/'([\w-]+)'/g)].map(([, value]) => ({ kind, value }));
});

const hunks = changeText(readEnvBaseSha(), ['src/', 'studio/src/'], context)
  .split(/^(?=diff --git )/m)
  .flatMap(section => {
    const [head, ...parts] = section.split(/^(?=@@ )/m);
    const file = /^diff --git a\/(\S+)/.exec(head)?.[1];
    return (parts.length ? parts : [head]).map(hunk => ({ file, rows: hunk.trimEnd().split('\n') }));
  });

const around = (rows, names) => {
  const hits = rows.flatMap((row, i) => (/^[+-](?![+-]{2} )/.test(row) && names.test(row) ? [i] : []));
  if (!hits.length) return '';
  const near = i => hits.some(hit => Math.abs(hit - i) <= context);
  return rows
    .map((row, i) => (near(i) ? row : '…'))
    .filter((row, i, all) => row !== '…' || all[i - 1] !== '…')
    .join('\n');
};

for (const { kind, value } of values) {
  const names = new RegExp(`['"\`]${value}['"\`]`);
  const touching = hunks.map(({ file, rows }) => ({ file, code: around(rows, names) })).filter(({ code }) => code);
  if (!touching.length) continue;
  const code = touching.map(({ file, code }) => `${file}\n${code}`).join('\n\n');
  const transitions = code.length > maxChars ? `${code.slice(0, maxChars)}\n[clipped]` : code;
  console.log(JSON.stringify({ [kind]: value, transitions }));
}
