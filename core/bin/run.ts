/**
 * Looks at one issue once: reenters its parked run, or begins one, and drives it until it parks or ends.
 * Usage: node core/bin/run.ts --hub <dir> --issue <n> --data <dir>
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { start } from '../src/main.ts';

const { values } = parseArgs({
  options: { hub: { type: 'string' }, issue: { type: 'string' }, data: { type: 'string' } },
});
const issue = Number(values.issue);
if (!values.hub || !values.data || !Number.isInteger(issue) || issue < 1) {
  console.error('usage: node core/bin/run.ts --hub <dir> --issue <n> --data <dir>');
  process.exit(2);
}

const runs = await start({ hub: resolve(values.hub), issue, data: resolve(values.data) });
for (const run of runs) console.log(`${run.id} ${run.step} ${run.status}${run.reason ? `: ${run.reason}` : ''}`);
if (runs.length === 0) console.log(`nothing to do on #${issue}`);
