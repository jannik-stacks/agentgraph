/**
 * Lists and prunes the Env images checkouts and scores start from, and removes seed volumes of dead processes.
 *
 *   node bin/env.ts list
 *   node bin/env.ts prune [--days 14] [--dry]
 *   node bin/env.ts sweep
 */
import { parseArgs } from 'node:util';
import { envs, prune, sweep } from '../src/env.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { days: { type: 'string', default: '14' }, dry: { type: 'boolean', default: false } },
});
const [command] = positionals;
if (command === 'list')
  for (const e of await envs())
    console.log(`${e.image}  ${e.size}  ${e.used ? new Date(e.used).toISOString() : 'never used'}`);
else if (command === 'prune') {
  const removed = await prune(Number(values.days), values.dry);
  console.log(`${values.dry ? 'would remove' : 'removed'} ${removed.length}${removed.map(i => `\n  ${i}`).join('')}`);
} else if (command === 'sweep') console.log(`removed ${await sweep()} seed volumes`);
else {
  console.error('usage: node bin/env.ts (list | prune [--days 14] [--dry] | sweep)');
  process.exit(1);
}
