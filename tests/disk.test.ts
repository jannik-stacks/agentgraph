import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collect,
  DiskLow,
  inventory,
  type DiskCacheEntry,
  pin,
  pickCacheRemovals,
  ensureFreeDisk,
  findBuildDirs,
  unpin,
  readEnvRefs,
  writeEnvRefs,
} from '../src/disk.ts';
import { startHeartbeat } from '../src/owner.ts';
import { envVersion } from '../src/env.ts';
import { faked } from './fixtures.ts';
import { tmp, write } from './kit.ts';

const GB = 1e9;
const item = (id: string, more: Partial<DiskCacheEntry> = {}): DiskCacheEntry => ({
  kind: 'env',
  refs: [id],
  bytes: GB,
  used: 0,
  ...more,
});

describe('pickCacheRemovals', () => {
  it('takes orphans always, then the oldest unheld items, until under the limit', () => {
    const items = [
      item('a:new', { used: 3 }),
      item('a:old', { used: 1 }),
      item('a:held', { used: 0, held: 'container' }),
      item('agentgraph-lower-gone', { kind: 'lower', always: true }),
      item('busy-tree', { kind: 'tree', always: true, held: 'busy' }),
    ];
    const ids = (o: Parameters<typeof pickCacheRemovals>[1]) => pickCacheRemovals(items, o).map(i => i.refs[0]);
    expect(ids({ limit: 10 * GB, free: Infinity, floor: 0 })).toEqual(['agentgraph-lower-gone']);
    expect(ids({ limit: 2.5 * GB, free: Infinity, floor: 0 })).toEqual(['agentgraph-lower-gone', 'a:old']);
    expect(ids({ limit: 10 * GB, free: 1 * GB, floor: 3.5 * GB })).toEqual(['agentgraph-lower-gone', 'a:old', 'a:new']);
  });
});

/** A docker holding two current sandbox setups, an unlabeled and a compose image, an orphan lower, and volumes that are data. */
const box = {
  'image ls --filter': '',
  'image ls': [
    'sha256:e1 agentgraph-env/r:k1',
    'sha256:e2 agentgraph-env/r:k2',
    'sha256:l1 agentgraph-env/unlabeled:abc',
    'sha256:l2 agentgraph-env/bench-any:abc',
    'sha256:s0 agentgraph-sandbox:local',
    'sha256:p0 postgres:17-alpine',
    '',
  ].join('\\n'),
  'image inspect --format {{.Id}}': [
    `sha256:e1 2026-10-01T00:00:00Z [] ${'{"agentgraph.env":"k1","agentgraph.lowerkb":"1000"}'}`,
    `sha256:e2 2026-10-02T00:00:00Z [] ${'{"agentgraph.env":"k2","agentgraph.lowerkb":"0"}'}`,
    'sha256:l1 2026-10-22T00:00:00Z [] {}',
    'sha256:l2 2026-10-22T00:00:00Z [] {"agentgraph.env":"abc","com.docker.compose.project":"x"}',
    '',
  ].join('\\n'),
  'system df': JSON.stringify({
    Images: [
      { ID: 'sha256:e1', UniqueSize: '3MB' },
      { ID: 'sha256:e2', UniqueSize: '5MB' },
      { ID: 'sha256:l1', UniqueSize: '3.5GB' },
    ],
  }),
  'volume ls --format': [
    'agentgraph-lower-k1\tagentgraph.lower=k1',
    'agentgraph-lower-gone\tagentgraph.lower=gone',
    'agentgraph-cache\t',
    'pgdata\tcom.docker.compose.project=x',
    'agentgraph-lower-x\tcom.docker.compose.project=x',
    'mine\t',
    '',
  ].join('\\n'),
  'ps -a': 'agentgraph-env/r:k2|agentgraph-cache\\npostgres:17-alpine|pgdata\\n',
};

describe('inventory', () => {
  it('rejects unreadable inventory instead of reporting an empty cache', async () => {
    await faked({ 'system df': 'broken' }, async () => {
      await expect(inventory()).rejects.toThrow(SyntaxError);
    });
  });

  it.each(['broken', '{"until":"bad","match":["*"]}'])(
    'rejects malformed pin %s instead of allowing removal',
    async text => {
      await faked({ 'system df': '{}' }, async () => {
        pin('broken', ['*'], 1);
        writeFileSync(join(process.env.AGENTGRAPH_STATE!, 'pins', 'broken.json'), text);
        await expect(inventory()).rejects.toThrow('invalid cache pin broken.json');
      });
    }
  );

  it('counts a volume docker cannot measure yet as empty', async () => {
    const df = JSON.stringify({ Images: [], Volumes: [{ Name: 'agentgraph-lower-gone', Size: '-1B' }] });
    await faked({ ...box, 'system df': df }, async () => {
      const items = await inventory();
      expect(items.find(i => i.refs[0] === 'agentgraph-lower-gone')?.bytes).toBe(0);
    });
  });

  it('counts unique bytes of our caches only, and holds what a container uses', async () => {
    await faked(box, async () => {
      const items = await inventory();
      const by = Object.fromEntries(items.map(i => [i.refs[0], i]));
      expect(Object.keys(by).sort()).toEqual(['agentgraph-env/r:k1', 'agentgraph-env/r:k2', 'agentgraph-lower-gone']);
      expect(by['agentgraph-env/r:k1']).toMatchObject({
        kind: 'env',
        refs: ['agentgraph-env/r:k1', 'agentgraph-lower-k1'],
        bytes: 3000000 + 1000 * 1024,
      });
      expect(by['agentgraph-env/r:k2']?.held).toBe('container');
      expect(by['agentgraph-lower-gone']).toMatchObject({ kind: 'lower', always: true });
    });
  });

  it('reads sizes from docker system df, and volume sizes only when measuring', async () => {
    const df = readFileSync(join(import.meta.dirname, 'fixtures/docker-df.json'), 'utf8').trim();
    const id = 'sha256:fdecf296d1b113717213c2eefc8bff182d0394d8e206553e4827e41a95fdad6b';
    const env = 'agentgraph-env/acme-token-metadata-api:8955f4891bdf3f555b0dffc9';
    await faked(
      {
        'system df': df,
        'image ls': `${id} ${env}\\nsha256:63538dfe497cc29dfafdda25ada09b46db68a3f4cc205abf1f5d6bf0913f3384 node:22\\n`,
        'image inspect --format {{.Id}}': `${id} 2026-10-23T00:00:00Z [] {"agentgraph.env":"8955f4891bdf3f555b0dffc9","agentgraph.lowerkb":"375220"}\\n`,
        'volume ls --format': [
          'agentgraph-lower-8955f4891bdf3f555b0dffc9\\tagentgraph.lower=8955f4891bdf3f555b0dffc9',
          'agentgraph-lower-67b09dcfc491777cfdbd7fd2\\tagentgraph.lower=67b09dcfc491777cfdbd7fd2',
          'agentgraph-cache\\t',
          'pgdata\\tcom.docker.compose.project=x',
          '',
        ].join('\\n'),
      },
      async () => {
        const by = async (measure: boolean) =>
          Object.fromEntries((await inventory({ measure })).map(i => [i.refs[0], i.bytes]));
        expect(await by(true)).toEqual({
          [env]: 418.4e3 + 375220 * 1024,
          'agentgraph-lower-67b09dcfc491777cfdbd7fd2': 281.5e6,
        });
        expect((await by(false))['agentgraph-lower-67b09dcfc491777cfdbd7fd2']).toBe(0);
      }
    );
  });

  it('takes a sandbox setup of an old family version or a replaced base image whatever the cap, unless held', async () => {
    const env = (id: string, labels: string, layers: string) => `sha256:${id} 2026-10-01T00:00:00Z ${layers} ${labels}`;
    await faked(
      {
        'system df': '{}',
        'image ls --filter': '',
        'image ls': [
          'sha256:a agentgraph-env/r:a',
          'sha256:b agentgraph-env/r:b',
          'sha256:c agentgraph-env/r:c',
          'sha256:d agentgraph-env/r:d',
          'sha256:s1 agentgraph-sandbox:services',
          '',
        ].join('\\n'),
        'image inspect --format {{.Id}}': [
          env('a', `{"agentgraph.env":"a","agentgraph.version":"${envVersion}"}`, '["l1","l2","ea"]'),
          env('b', `{"agentgraph.env":"b","agentgraph.version":"5"}`, '["l1","l2","eb"]'),
          env('c', `{"agentgraph.env":"c","agentgraph.version":"${envVersion}"}`, '["l1","old","ec"]'),
          env('d', `{"agentgraph.env":"d","agentgraph.version":"${envVersion}"}`, '["l1","old","ed"]'),
          '',
        ].join('\\n'),
        'image inspect --format {{json .RootFS.Layers}}': '["l1"]\\n["l1","l2"]\\n',
        'volume ls --format': 'agentgraph-lower-d\\tagentgraph.lower=d\\n',
        'ps -a': 'agentgraph-env/r:d|x\\n',
      },
      async () => {
        const by = Object.fromEntries((await inventory()).map(i => [i.refs[0], i]));
        expect(by['agentgraph-env/r:a']?.always).toBeUndefined();
        expect(by['agentgraph-env/r:b']).toMatchObject({ always: true, gone: 'old version' });
        expect(by['agentgraph-env/r:c']).toMatchObject({ always: true, gone: 'base replaced' });
        expect(by['agentgraph-env/r:d']).toMatchObject({ always: true, held: 'container' });
        const { removed } = await collect({ dry: true, limit: 1e15 });
        expect(removed.map(i => i.refs[0]).sort()).toEqual(['agentgraph-env/r:b', 'agentgraph-env/r:c']);
      }
    );
  });

  it('holds what a pin names until the pin expires', async () => {
    await faked(box, async () => {
      pin('luna', ['agentgraph-env/r:*', 'agentgraph-lower-gone'], 14);
      const held = (await inventory()).filter(i => i.held?.startsWith('pin')).map(i => i.refs[0]);
      expect(held.sort()).toEqual(['agentgraph-env/r:k1', 'agentgraph-lower-gone']);
      pin('luna', ['agentgraph-lower-gone'], -1);
      expect((await inventory()).some(i => i.held?.startsWith('pin'))).toBe(false);
      unpin('luna');
    });
  });
});

describe('collect', () => {
  it('only reports in a dry run, and removes without force otherwise, never data volumes', async () => {
    await faked(box, async log => {
      const dry = await collect({ dry: true, limit: 0 });
      expect(dry.removed.map(i => i.refs[0])).toContain('agentgraph-env/r:k1');
      expect(log()).not.toMatch(/^(rmi|volume rm)/m);
      await collect({ limit: 0 });
      expect(log()).toContain('rmi agentgraph-env/r:k1\n');
      expect(log()).toContain('volume rm agentgraph-lower-k1\n');
      expect(log()).toContain('volume rm agentgraph-lower-gone\n');
      expect(log()).not.toContain('agentgraph-env/r:k2\n');
      expect(log()).not.toMatch(
        / -f\b|pgdata\n|agentgraph-lower-x|agentgraph-env\/(bench-any|unlabeled)|volume rm (mine|agentgraph-cache)/
      );
    });
  });

  it('removes a score tree nobody holds, and a tagged target dir only past the limit', async () => {
    await faked({ 'system df': '{}' }, async () => {
      const root = tmp('runs');
      write(root, { 'r/i0/case-1/case.json': '{}' });
      write(root, { 'r/i0/case-1/tree/target/x': 'x'.repeat(5000) });
      write(root, { 'r/i0/case-1/v2/diff.patch': '' });
      write(root, { 'target-shared/CACHEDIR.TAG': 'x'.repeat(5000) });
      const { removed } = await collect({ roots: [root] });
      expect(removed.map(i => i.refs[0])).toEqual([join(root, 'r/i0/case-1/tree')]);
      expect((await collect({ roots: [root], limit: 0 })).removed.map(i => i.refs[0])).toEqual([
        join(root, 'target-shared'),
      ]);
    });
  });
});

const caches = (more = '') => ({
  ...box,
  'image inspect --format {{.Id}}': box['image inspect --format {{.Id}}'].replace(
    '"agentgraph.env":"k1",',
    '"agentgraph.env":"k1","agentgraph.cache":"agentgraph-cache-r-env",'
  ),
  'volume ls --format': [
    'agentgraph-cache-r-new\tagentgraph.cache=agentgraph-cache-r-new',
    'agentgraph-cache-r-env\tagentgraph.cache=agentgraph-cache-r-env',
    'agentgraph-cache-r-run\tagentgraph.cache=agentgraph-cache-r-run',
    'agentgraph-cache\t',
    'agentgraph-copy\tagentgraph.cache=agentgraph-cache-r-new',
    more,
  ].join('\\n'),
  'ps -a': 'agentgraph-sandbox:local|agentgraph-cache-r-run,agentgraph-cache\\n',
  'system df': JSON.stringify({ Volumes: [{ Name: 'agentgraph-cache-r-new', Size: '2GB' }] }),
});
const removals = (log: () => string) =>
  log()
    .split('\n')
    .filter(l => l.startsWith('volume rm'));

describe('toolchain cache volumes', () => {
  it('lists labelled cache volumes with their size, and holds what a container or an environment uses', async () => {
    await faked(caches(), async () => {
      const by = Object.fromEntries((await inventory()).filter(i => i.kind === 'cache').map(i => [i.refs[0], i]));
      expect(Object.keys(by).toSorted()).toEqual([
        'agentgraph-cache-r-env',
        'agentgraph-cache-r-new',
        'agentgraph-cache-r-run',
      ]);
      expect(by['agentgraph-cache-r-new']).toMatchObject({ bytes: 2e9 });
      expect(by['agentgraph-cache-r-new']?.held).toBeUndefined();
      expect(by['agentgraph-cache-r-env']?.held).toBe('environment');
      expect(by['agentgraph-cache-r-run']?.held).toBe('container');
    });
  });

  it('removes unused cache volumes past the cap, never a mounted one or the bare default volume', async () => {
    await faked(caches(), async log => {
      await collect({});
      expect(removals(log)).toEqual([]);
      await collect({ limit: 0 });
      expect(removals(log)).toContain('volume rm agentgraph-cache-r-new');
      expect(log()).not.toMatch(/volume rm (agentgraph-cache-r-run|agentgraph-cache|agentgraph-copy)\n/);
    });
  });

  it.each([
    ['pinned', undefined],
    ['out of scope', ['agentgraph-cache-r-env']],
  ])('keeps the cache volume of a kept environment that is %s', async (_, eligible) => {
    await faked(caches(), async log => {
      pin('keep', ['agentgraph-env/r:k1'], 1);
      await collect({ limit: 0, ...(eligible && { eligible }) });
      expect(log()).not.toContain('rmi agentgraph-env/r:k1');
      expect(removals(log)).not.toContain('volume rm agentgraph-cache-r-env');
      expect((await inventory()).find(i => i.refs[0] === 'agentgraph-cache-r-env')?.held).toBe('environment');
    });
  });

  it('keeps a cache volume a live checkout overlays', async () => {
    const owner = startHeartbeat();
    const live = `agentgraph-layer-x-c-o\tagentgraph.lower=agentgraph-cache-r-new,agentgraph.layer=${owner}`;
    await faked(caches(live), async () => {
      const item = (await inventory()).find(i => i.refs[0] === 'agentgraph-cache-r-new');
      expect(item?.held).toBe('live checkout');
    });
  });

  it('collects only the cache volumes recorded in scope', async () => {
    await faked(caches(), async log => {
      await collect({ eligible: ['agentgraph-cache-r-new'], limit: 0 });
      expect(removals(log)).toEqual(['volume rm agentgraph-cache-r-new']);
    });
  });

  it('measures docker free space under a container root without mounting a volume', async () => {
    await faked(
      { ...box, run: 'Filesystem 1024-blocks Used Available Capacity Mounted\\noverlay 100 1 50 1 /\\n' },
      async log => {
        await expect(ensureFreeDisk({ dir: tmp('disk'), image: 'img' }, 1e9)).rejects.toBeInstanceOf(DiskLow);
        const run = log()
          .split('\n')
          .find(l => l.startsWith('run '));
        expect(run).toMatch(/ img df -Pk \/$/);
        expect(run).not.toContain('type=volume');
      }
    );
  });
});

describe('findBuildDirs', () => {
  it('finds score trees beside a case and tagged target dirs, never inside records', () => {
    const root = tmp('runs');
    write(root, { 'a/case.json': '' });
    mkdirSync(join(root, 'a/tree'));
    write(root, { 'x/y/z/case.json': '' });
    mkdirSync(join(root, 'x/y/z/tree'));
    mkdirSync(join(root, 'b/tree'), { recursive: true });
    write(root, { '.attic/a/case.json': '' });
    mkdirSync(join(root, '.attic/a/tree'));
    write(root, { 't/target-shared/CACHEDIR.TAG': '' });
    mkdirSync(join(root, 'u/target-shared'), { recursive: true });
    expect(findBuildDirs(root).sort()).toEqual(['a/tree', 't/target-shared', 'x/y/z/tree'].map(p => join(root, p)));
  });

  it('never enters the results, cache, engine, cases or logs of a bench dir', () => {
    const root = tmp('bench');
    const run = 'sha/opencode-luna/r1/c1';
    for (const f of ['case.json', 'v2/diff.patch', 'v2/score.json', 'v2/graph/case.json', 'valid.json'])
      write(root, { [`${run}/${f}`]: '' });
    for (const d of [`${run}/tree`, `${run}/v2/graph/tree`]) mkdirSync(join(root, d), { recursive: true });
    for (const d of ['.cache/slot', 'sha/engine/agentgraph/x', 'cases/c1', 'done/x', 'logs/x']) {
      write(root, { [`${d}/case.json`]: '' });
      mkdirSync(join(root, d, 'tree'));
    }
    expect(findBuildDirs(root)).toEqual([join(root, run, 'tree')]);
  });
});

describe('environment ownership ledger', () => {
  it('rejects unknown recorded refs', () => {
    const dir = tmp('data');
    write(dir, { '.envs/refs.jsonl': '42\n' });
    expect(() => readEnvRefs(dir)).toThrow('invalid environment refs');
  });

  it('records cache volumes of any name docker accepts, and refuses others before writing', () => {
    const dir = tmp('data');
    writeEnvRefs(dir, ['TeamCache-project-0123456789abcdef01234567', 'agentgraph-env/r:k1']);
    expect(readEnvRefs(dir)).toEqual(['TeamCache-project-0123456789abcdef01234567', 'agentgraph-env/r:k1']);
    expect(() => writeEnvRefs(dir, ['agentgraph-env/r:k2', 'x,dst=/etc'])).toThrow('invalid environment ref');
    expect(readEnvRefs(dir)).toHaveLength(2);
  });

  it('records refs in a directory without confusing the run store', async () => {
    const dir = tmp('data');
    writeEnvRefs(dir, ['agentgraph-env/r:k1']);
    writeEnvRefs(dir, ['agentgraph-env/r:k1', 'agentgraph-env/r:k2']);
    expect(readEnvRefs(dir)).toEqual(['agentgraph-env/r:k1', 'agentgraph-env/r:k2']);
    const { Effect } = await import('effect');
    const { fileStore, Store } = await import('../src/store.ts');
    const runs = await Effect.runPromise(
      Store.pipe(
        Effect.flatMap(s => s.list()),
        Effect.provide(fileStore(dir))
      )
    );
    expect(runs).toEqual([]);
  });
});

describe('scoped collection', () => {
  it("counts an environment's cache layer toward the cap", async () => {
    const vols = `${box['volume ls --format']}agentgraph-lower-k1-c\tagentgraph.lower=k1\\n`;
    const df = JSON.stringify({
      ...JSON.parse(box['system df']),
      Volumes: [{ Name: 'agentgraph-lower-k1-c', Size: '70GB' }],
    });
    await faked({ ...box, 'volume ls --format': vols, 'system df': df }, async log => {
      await collect({ eligible: ['agentgraph-env/r:k1'], limit: 60 * GB });
      expect(log()).toContain('rmi agentgraph-env/r:k1');
    });
  });

  it("removes an environment's cache layer with it, and a left one alone", async () => {
    const vols = `${box['volume ls --format']}agentgraph-lower-k1-c\tagentgraph.lower=k1\\nagentgraph-lower-gone-c\tagentgraph.lower=gone\\n`;
    await faked({ ...box, 'volume ls --format': vols }, async log => {
      const items = await inventory();
      expect(items.find(i => i.refs[0] === 'agentgraph-env/r:k1')?.refs).toEqual([
        'agentgraph-env/r:k1',
        'agentgraph-lower-k1',
        'agentgraph-lower-k1-c',
      ]);
      expect(items.find(i => i.refs[0] === 'agentgraph-lower-gone-c')).toMatchObject({ kind: 'lower', always: true });
      await collect({ eligible: ['agentgraph-env/r:k1'], limit: 0 });
      expect(
        log()
          .split('\n')
          .filter(l => /^(rmi|volume rm)/.test(l))
      ).toEqual(['rmi agentgraph-env/r:k1', 'volume rm agentgraph-lower-k1', 'volume rm agentgraph-lower-k1-c']);
    });
  });

  it('drops only recorded, labelled envs beside another repo', async () => {
    await faked(box, async log => {
      await collect({ eligible: ['agentgraph-env/r:k1', 'agentgraph-env/unlabeled:abc'], limit: 0 });
      const removals = log()
        .split('\n')
        .filter(l => /^(rmi|volume rm)/.test(l));
      expect(removals).toEqual(['rmi agentgraph-env/r:k1', 'volume rm agentgraph-lower-k1']);
    });
  });

  it('keeps a lower when another repo retains its key', async () => {
    await faked(
      {
        'image ls --filter': 'agentgraph-env/other:k1',
        ...Object.fromEntries(Object.entries(box).filter(([k]) => k !== 'image ls --filter')),
      },
      async log => {
        await collect({ eligible: ['agentgraph-env/r:k1'], limit: 0 });
        expect(log()).toContain('rmi agentgraph-env/r:k1');
        expect(log()).not.toContain('volume rm');
      }
    );
  });

  it('keeps aliases, container holds and pins', async () => {
    const images = `${box['image ls']}sha256:e1 agentgraph-env/other:k1\\n`;
    await faked({ ...box, 'image ls': images }, async log => {
      pin('owned', ['agentgraph-env/r:k*'], 1);
      await collect({ eligible: ['agentgraph-env/r:k1', 'agentgraph-env/r:k2'], limit: 0 });
      expect(
        log()
          .split('\n')
          .filter(l => /^(rmi|volume rm)/.test(l))
      ).toEqual([]);
    });
  });

  it.each([
    ['its dependency overlay', 'agentgraph.lower=k1'],
    ['the cache overlay of a layered environment', 'agentgraph.lower=agentgraph-cache-r,agentgraph.env=k1'],
  ])('keeps a lower a live checkout reads through %s', async (_, labels) => {
    const owner = startHeartbeat();
    await faked(
      {
        ...box,
        'volume ls --format': `${box['volume ls --format']}agentgraph-layer-live\t${labels},agentgraph.layer=${owner}\\n`,
      },
      async log => {
        await collect({ eligible: ['agentgraph-env/r:k1'], limit: 0 });
        expect(
          log()
            .split('\n')
            .filter(l => /^(rmi|volume rm)/.test(l))
        ).toEqual([]);
      }
    );
  });

  it.each([undefined, []])(
    'blocks on low disk without global sweeping or unrelated removals with scope %j',
    async eligible => {
      await faked(box, async log => {
        await expect(ensureFreeDisk({ dir: tmp('disk'), ...(eligible && { eligible }) }, 1e9)).rejects.toBeInstanceOf(
          DiskLow
        );
        expect(
          log()
            .split('\n')
            .filter(l => /^(rmi|volume rm|volume ls --filter)/.test(l))
        ).toEqual([]);
      });
    }
  );
});

describe('ensureFreeDisk', () => {
  it('collects, then refuses with the held cache and the command that frees it', async () => {
    await faked(box, async () => {
      await expect(ensureFreeDisk({ dir: tmp('disk') }, 0)).resolves.toBeUndefined();
      pin('luna', ['agentgraph-env/*'], 14);
      const low = await ensureFreeDisk(
        { dir: tmp('disk'), eligible: ['agentgraph-env/r:k1', 'agentgraph-env/r:k2'] },
        1e9
      ).catch((e: unknown) => e);
      expect(low).toBeInstanceOf(DiskLow);
      expect(String((low as Error).message)).toMatch(/^disk low: [\d.]+ GB free, need 1000000000 GB/);
      expect((low as Error).message).toContain('pin luna');
      expect((low as Error).message).toContain('node bin/env.ts unpin luna');
    });
  });
});

describe('last use', () => {
  it('orders sandbox setups by their last-use stamp', async () => {
    await faked(box, async () => {
      const envs = join(process.env.AGENTGRAPH_STATE!, 'envs');
      mkdirSync(envs, { recursive: true });
      for (const [key, at] of [
        ['k1', 2000],
        ['k2', 1000],
      ] as const) {
        writeFileSync(join(envs, key), '');
        utimesSync(join(envs, key), at, at);
      }
      const used = Object.fromEntries((await inventory()).map(i => [i.refs[0], i.used]));
      expect(used['agentgraph-env/r:k1']).toBe(2_000_000);
    });
  });
});
