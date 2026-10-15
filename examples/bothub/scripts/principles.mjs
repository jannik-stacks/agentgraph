// One JSON line per principle the reply names with a file:line: the principle's rule and the changed hunk at that line.
//
//   node principles.mjs      reads the reply from BOTHUB_REPLY and the rules from $BOTHUB_HUB/skills/principles.md
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(join(process.env.BOTHUB_HUB ?? join(here, '..'), 'skills/principles.md'), 'utf8');
const rules = skill
  .split(/^## /m)
  .slice(1)
  .map(s => ({ name: s.split('\n')[0], rule: s.replace(/\n\nAdapted from.*/s, '').trim() }));
const hunks = execFileSync(process.execPath, [join(here, 'hunks.mjs'), ''], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .map(line => JSON.parse(line));

for (const text of (process.env.BOTHUB_REPLY ?? '').split('\n'))
  for (const { name, rule } of rules) {
    if (!text.toLowerCase().includes(name.toLowerCase())) continue;
    for (const [, file, line] of text.matchAll(/([\w./-]+\.\w+):(\d+)/g)) {
      const at = hunks.filter(h => h.file === file && h.line <= Number(line)).at(-1);
      const hunk = at?.hunk ?? '(no changed hunk at that line)';
      console.log(JSON.stringify({ path: `${file}:${line} ${name}`, principle: rule, hunk }));
    }
  }
