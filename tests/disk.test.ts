import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collect, DiskLow, inventory, type Item, pin, plan, room, trees, unpin } from '../src/disk.ts';
import { envVersion } from '../src/env.ts';
import { faked } from './fixtures.ts';
import { tmp, write } from './kit.ts';

const GB = 1e9;
const item = (id: string, more: Partial<Item> = {}): Item => ({ kind: 'env', refs: [id], bytes: GB, used: 0, ...more });

describe('plan', () => {
  it('takes orphans always, then the oldest unheld items, until under the limit', () => {
    const items = [
      item('a:new', { used: 3 }),
      item('a:old', { used: 1 }),
      item('a:held', { used: 0, held: 'container' }),
      item('agentgraph-lower-gone', { kind: 'lower', always: true }),
      item('busy-tree', { kind: 'tree', always: true, held: 'busy' }),
    ];
    const ids = (o: Parameters<typeof plan>[1]) => plan(items, o).map(i => i.refs[0]);
    expect(ids({ limit: 10 * GB, free: Infinity, floor: 0 })).toEqual(['agentgraph-lower-gone']);
    expect(ids({ limit: 2.5 * GB, free: Infinity, floor: 0 })).toEqual(['agentgraph-lower-gone', 'a:old']);
    expect(ids({ limit: 10 * GB, free: 1 * GB, floor: 3.5 * GB })).toEqual(['agentgraph-lower-gone', 'a:old', 'a:new']);
  });
});

/** A docker holding two current Envs, an unlabeled and a compose image, an orphan lower, and volumes that are data. */
const box = {
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

  it('takes an Env of an old family version or a replaced base image whatever the cap, unless held', async () => {
    const env = (id: string, labels: string, layers: string) => `sha256:${id} 2026-10-01T00:00:00Z ${layers} ${labels}`;
    await faked(
      {
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
    await faked({}, async () => {
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

describe('trees', () => {
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
    expect(trees(root).sort()).toEqual(['a/tree', 't/target-shared', 'x/y/z/tree'].map(p => join(root, p)));
  });

  it('never enters the results, cache, engine, cases or logs of a bench dir', () => {
    const root = tmp('bench');
    const run = 'sha/opencode-luna/r1/c1';
    for (const f of ['case.json', 'v2/diff.patch', 'v2/score.json', 'v2/hub/case.json', 'valid.json'])
      write(root, { [`${run}/${f}`]: '' });
    for (const d of [`${run}/tree`, `${run}/v2/hub/tree`]) mkdirSync(join(root, d), { recursive: true });
    for (const d of ['.cache/slot', 'sha/engine/agentgraph/x', 'cases/c1', 'done/x', 'logs/x']) {
      write(root, { [`${d}/case.json`]: '' });
      mkdirSync(join(root, d, 'tree'));
    }
    expect(trees(root)).toEqual([join(root, run, 'tree')]);
  });
});

describe('room', () => {
  it('collects, then refuses with the held cache and the command that frees it', async () => {
    await faked(box, async () => {
      await expect(room({ dir: tmp('disk') }, 0)).resolves.toBeUndefined();
      pin('luna', ['agentgraph-env/*'], 14);
      const low = await room({ dir: tmp('disk') }, 1e9).catch((e: unknown) => e);
      expect(low).toBeInstanceOf(DiskLow);
      expect(String((low as Error).message)).toMatch(/^disk low: [\d.]+ GB free, need 1000000000 GB/);
      expect((low as Error).message).toContain('pin luna');
      expect((low as Error).message).toContain('node bin/env.ts unpin luna');
    });
  });
});

describe('last use', () => {
  it('orders Envs by their last-use stamp', async () => {
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
