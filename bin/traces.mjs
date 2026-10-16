// Fails when a session in a data dir's traces started but cost nothing: its usage was never read or never priced.
// Usage: node bin/traces.mjs <data dir>
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const data = process.argv[2];
if (!data) {
  console.error('usage: node bin/traces.mjs <data dir>');
  process.exit(2);
}

const lines = file =>
  readFileSync(file, 'utf8')
    .split('\n')
    .flatMap(line => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });

const free = [];
let sessions = 0;
for (const run of readdirSync(data)) {
  const file = join(data, run, 'trace.jsonl');
  if (!existsSync(file)) continue;
  for (const { step, session } of lines(file)) {
    if (typeof session !== 'object' || !session.id) continue;
    sessions++;
    if (!session.usd) free.push(`${run} ${step}: session ${session.id} ended ${session.ended} with usd 0`);
  }
}
if (free.length) console.log(free.join('\n'));
console.log(`${free.length} of ${sessions} sessions cost nothing`);
process.exit(free.length ? 1 : 0);
