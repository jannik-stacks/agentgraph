import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const braced = (text, open) => {
  const at = open.exec(text);
  if (!at) return undefined;
  let depth = 0;
  for (let i = at.index + at[0].length - 1; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}' && --depth === 0) return text.slice(at.index + at[0].length, i);
  }
};

export const readUsage = (root, path) => {
  const code = readFileSync(join(root, path), 'utf8')
    .split('\n')
    .filter(line => !/^\s*(\/\/|\/?\*)/.test(line))
    .join('\n');
  const options = braced(code, /options:\s*\{/);
  const table = [...code.matchAll(/(?:Flag\.\w+|\bflag)\('([\w-]+)'/g)].map(m => m[1]);
  const flags = options
    ? [...options.matchAll(/(?:^|[\n,{])\s*(?:'([\w-]+)'|(\w+)):\s*\{\s*type/g)].map(m => m[1] ?? m[2])
    : table.length
      ? [...table, 'help', 'version']
      : [...code.matchAll(/'--([\w-]+)'/g)].map(m => m[1]);
  const words = [...code.matchAll(/(?:(?:case|verb ===|verb !==) |^ {2}\[)'([\w-]+)'/gm)].map(m => m[1]);
  return { flags: new Set(flags), words: new Set(words) };
};
