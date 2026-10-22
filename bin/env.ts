/**
 * Lists and evicts the Env images checkouts and scores start from, and removes dependency volumes of dead runners.
 *
 *   node bin/env.ts list
 *   node bin/env.ts prune [--cap 60g] [--dry]
 *   node bin/env.ts sweep
 */
import { parseArgs } from 'node:util';
import { bytes, envs, evict, sweep } from '../src/env.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { cap: { type: 'string' }, dry: { type: 'boolean', default: false } },
});
const [command] = positionals;
if (command === 'list')
  for (const e of await envs())
    console.log(`${e.image}  ${e.size}  ${e.used ? new Date(e.used).toISOString() : 'never used'}`);
else if (command === 'prune') {
  const removed = await evict(values.cap ? bytes(values.cap) : undefined, values.dry);
  console.log(`${values.dry ? 'would remove' : 'removed'} ${removed.length}${removed.map(i => `\n  ${i}`).join('')}`);
} else if (command === 'sweep') console.log(`removed ${await sweep()} dependency volumes`);
else {
  console.error('usage: node bin/env.ts (list | prune [--cap 60g] [--dry] | sweep)');
  process.exit(1);
}
