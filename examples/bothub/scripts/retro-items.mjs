// The retro items pasted into this issue that nobody has judged yet, one JSON line each, in pasted order. An item is
// judged once its `retro:<id>` appears in any issue line that is not an item: a judge's reply or a filed issue.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(process.env.BOTHUB_HUB ?? '', 'issues');
const files = readdirSync(dir).filter(name => /^\d+-.*\.md$/.test(name));
const lines = files.flatMap(name => readFileSync(join(dir, name), 'utf8').split('\n'));
const item = line => /^\{"id":"retro:[0-9a-f]+"/.test(line.trim());
const judged = lines.filter(line => !item(line)).join('\n');
const mine = files.filter(name => name.startsWith(`${process.env.BOTHUB_ISSUE}-`));
const pasted = mine.flatMap(name => readFileSync(join(dir, name), 'utf8').split('\n')).filter(item);
const seen = new Set();
for (const line of pasted) {
  const { id } = JSON.parse(line);
  if (seen.has(id) || judged.includes(id)) continue;
  seen.add(id);
  console.log(line.trim());
}
