/**
 * Lists and collects the cache Envs, dependency volumes, the old engine's objects and score trees hold, pins what a
 * paused bench still needs, and removes dependency volumes of dead runners.
 *
 *   node bin/env.ts list [--root <dir>]...
 *   node bin/env.ts collect [--cap 60g] [--root <dir>]... [--dry-run]
 *   node bin/env.ts pin <name> <glob>... [--days 14]
 *   node bin/env.ts unpin <name>
 *   node bin/env.ts sweep
 */
import { parseArgs } from 'node:util';
import { bytes, collect, inventory, type Item, pin, unpin } from '../src/disk.ts';
import { sweep } from '../src/env.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    cap: { type: 'string' },
    root: { type: 'string', multiple: true, default: [] },
    days: { type: 'string', default: '14' },
    'dry-run': { type: 'boolean', default: false },
  },
});
const [command, name, ...globs] = positionals;
const gb = (b: number) => `${(b / 1e9).toFixed(2)} GB`;
const row = (i: Item) =>
  `  ${gb(i.bytes).padStart(10)}  ${i.kind.padEnd(6)}  ${i.refs.join(' ')}${i.gone ? `  (unreachable: ${i.gone})` : ''}${i.held ? `  (held: ${i.held})` : ''}`;
const sum = (items: Item[]) => gb(items.reduce((n, i) => n + i.bytes, 0));

if (command === 'list') {
  const items = await inventory({ roots: values.root, measure: true });
  for (const i of items.sort((a, b) => b.bytes - a.bytes)) console.log(row(i));
  console.log(`${items.length} items, ${sum(items)}`);
} else if (command === 'collect') {
  const dry = values['dry-run'];
  const { removed, items } = await collect({
    dry,
    roots: values.root,
    measure: true,
    ...(values.cap && { limit: bytes(values.cap) }),
  });
  console.log(`${dry ? 'would remove' : 'removed'} ${removed.length} items, ${sum(removed)}:`);
  for (const i of removed) console.log(row(i));
  const kept = items.filter(i => !removed.includes(i));
  console.log(`kept ${kept.length} items, ${sum(kept)}:`);
  for (const i of kept) console.log(row(i));
} else if (command === 'pin' && name && globs.length) pin(name, globs, Number(values.days));
else if (command === 'unpin' && name) unpin(name);
else if (command === 'sweep') console.log(`removed ${await sweep()} dependency volumes`);
else {
  console.error(
    'usage: node bin/env.ts (list | collect [--cap 60g] [--root <dir>]... [--dry-run] | pin <name> <glob>... [--days 14] | unpin <name> | sweep)'
  );
  process.exit(1);
}
