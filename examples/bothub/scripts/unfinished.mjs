// Work a change leaves unfinished or pretends to do: markers for later, and fakes or stubs in shipped code. The
// simulator and the tests are where those belong.
import { scan } from './line-rules.mjs';

const shipped = /^(src|studio\/src|bin)\/.*\.(ts|tsx|mts|js|mjs)$/;
const wanted = path => shipped.test(path) && !/^src\/sim[^/]*\.ts$/.test(path) && !path.startsWith('studio/src/lab/');

scan('unfinished', wanted, [
  [/\b(TODO|FIXME|XXX|HACK)\b/, 'a marker for later; finish it or open an issue'],
  [/not (yet )?implemented|\bunimplemented\b/i, 'a path that is not implemented'],
  [
    /\b(fake[ds]?|stub(bed|s)?|mock(ed|s)?|dummy)\b/i,
    'a fake in shipped code; build the real thing',
    (_, text) => !/placeholder=/.test(text),
  ],
]);
