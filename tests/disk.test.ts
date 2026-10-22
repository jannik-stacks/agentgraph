import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collect, DiskLow, inventory, type Item, pin, plan, room, trees, unpin } from '../src/disk.ts';
import { envVersion } from '../src/env.ts';
import { faked, put, tmp } from './fixtures.ts';

const GB = 1e9;
const item = (id: string, more: Partial<Item> = {}): Item => ({ kind: 'env', refs: [id], bytes: GB, used: 0, ...more });

describe('plan', () => {
  it('takes orphans always, then the oldest unheld items, legacy first, until under the limit', () => {
    const items = [
      item('a:new', { used: 3 }),
      item('a:old', { used: 1 }),
      item('a:held', { used: 0, held: 'container' }),
      item('bothub-env/x:1', { kind: 'legacy', used: 9 }),
      item('agentgraph-lower-gone', { kind: 'lower', always: true }),
      item('busy-tree', { kind: 'tree', always: true, held: 'busy' }),
    ];
    const ids = (o: Parameters<typeof plan>[1]) => plan(items, o).map(i => i.refs[0]);
    expect(ids({ limit: 10 * GB, free: Infinity, floor: 0 })).toEqual(['agentgraph-lower-gone']);
    expect(ids({ limit: 2.5 * GB, free: Infinity, floor: 0 })).toEqual([
      'agentgraph-lower-gone',
      'bothub-env/x:1',
      'a:old',
    ]);
    expect(ids({ limit: 10 * GB, free: 1 * GB, floor: 3.5 * GB })).toEqual([
      'agentgraph-lower-gone',
      'bothub-env/x:1',
      'a:old',
    ]);
  });
});

/** A docker holding two current Envs, one legacy pair, an orphan lower, and volumes that are data. */
const box = {
  'image ls': [
    'sha256:e1 agentgraph-env/r:k1',
    'sha256:e2 agentgraph-env/r:k2',
    'sha256:l1 bothub-env/acme-explorer:abc',
    'sha256:l2 bothub-env/bench-any:abc',
    'sha256:s0 agentgraph-sandbox:local',
    'sha256:p0 postgres:17-alpine',
    '',
  ].join('\\n'),
  'image inspect --format {{.Id}}': [
    `sha256:e1 2026-10-01T00:00:00Z [] ${'{"agentgraph.env":"k1","agentgraph.lowerkb":"1000"}'}`,
    `sha256:e2 2026-10-02T00:00:00Z [] ${'{"agentgraph.env":"k2","agentgraph.lowerkb":"0"}'}`,
    'sha256:l1 2026-10-22T00:00:00Z [] {"bothub.env":"abc"}',
    'sha256:l2 2026-10-22T00:00:00Z [] {"bothub.env":"abc","com.docker.compose.project":"x"}',
    '',
  ].join('\\n'),
  'history --human=false --format {{.Size}} sha256:e1': '3000000\\n0\\n',
  'history --human=false --format {{.Size}} sha256:e2': '5000000\\n0\\n',
  'history --human=false --format {{.Size}} sha256:l1': '3500000000\\n0\\n',
  'volume ls --format': [
    'agentgraph-lower-k1\tagentgraph.lower=k1',
    'agentgraph-lower-gone\tagentgraph.lower=gone',
    'agentgraph-cache\t',
    'bothub-layer-aa-0\t',
    'bothub-cache\t',
    'bothub_pgdata\tcom.docker.compose.project=bothub',
    'bothub-lower-x\tcom.docker.compose.project=bothub',
    'mine\t',
    '',
  ].join('\\n'),
  'ps -a': 'agentgraph-env/r:k2|agentgraph-cache\\npostgres:17-alpine|bothub_pgdata\\n',
};

describe('inventory', () => {
  it('counts unique bytes of our caches only, and holds what a container uses', async () => {
    await faked(box, async () => {
      const items = await inventory();
      const by = Object.fromEntries(items.map(i => [i.refs[0], i]));
      expect(Object.keys(by).sort()).toEqual([
        'agentgraph-env/r:k1',
        'agentgraph-env/r:k2',
        'agentgraph-lower-gone',
        'bothub-cache',
        'bothub-env/acme-explorer:abc',
        'bothub-layer-aa-0',
      ]);
      expect(by['agentgraph-env/r:k1']).toMatchObject({
        kind: 'env',
        refs: ['agentgraph-env/r:k1', 'agentgraph-lower-k1'],
        bytes: 3000000 + 1000 * 1024,
      });
      expect(by['agentgraph-env/r:k2']?.held).toBe('container');
      expect(by['bothub-env/acme-explorer:abc']).toMatchObject({ kind: 'legacy', bytes: 3.5e9 });
      expect(by['agentgraph-lower-gone']).toMatchObject({ kind: 'lower', always: true });
      expect(by['bothub-layer-aa-0']).toMatchObject({ kind: 'legacy', always: true });
      expect(by['bothub-cache']).toMatchObject({ kind: 'legacy' });
      expect(by['bothub-cache']?.always).toBeUndefined();
    });
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
      pin('luna', ['bothub-env/acme-explorer:*', 'bothub-cache'], 14);
      const held = (await inventory()).filter(i => i.held?.startsWith('pin')).map(i => i.refs[0]);
      expect(held.sort()).toEqual(['bothub-cache', 'bothub-env/acme-explorer:abc']);
      pin('luna', ['bothub-cache'], -1);
      expect((await inventory()).some(i => i.held?.startsWith('pin'))).toBe(false);
      unpin('luna');
    });
  });
});

describe('collect', () => {
  it('only reports in a dry run, and removes without force otherwise, never data volumes', async () => {
    await faked(box, async log => {
      const dry = await collect({ dry: true, limit: 0 });
      expect(dry.removed.map(i => i.refs[0])).toContain('bothub-env/acme-explorer:abc');
      expect(log()).not.toMatch(/^(rmi|volume rm)/m);
      await collect({ limit: 0 });
      expect(log()).toContain('rmi agentgraph-env/r:k1\n');
      expect(log()).toContain('volume rm agentgraph-lower-k1\n');
      expect(log()).toContain('volume rm agentgraph-lower-gone\n');
      expect(log()).not.toContain('agentgraph-env/r:k2\n');
      expect(log()).not.toMatch(
        / -f\b|bothub_pgdata\n|bothub-lower-x|rmi bothub-env\/bench-any|volume rm (mine|agentgraph-cache)/
      );
    });
  });

  it('removes a score tree nobody holds, and a tagged target dir only past the limit', async () => {
    await faked({}, async () => {
      const root = tmp('runs');
      put(root, 'r/i0/case-1/case.json', '{}');
      put(root, 'r/i0/case-1/tree/target/x', 'x'.repeat(5000));
      put(root, 'r/i0/case-1/v2/diff.patch');
      put(root, 'target-shared/CACHEDIR.TAG', 'x'.repeat(5000));
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
    put(root, 'a/case.json');
    mkdirSync(join(root, 'a/tree'));
    put(root, 'x/y/z/case.json');
    mkdirSync(join(root, 'x/y/z/tree'));
    mkdirSync(join(root, 'b/tree'), { recursive: true });
    put(root, '.attic/a/case.json');
    mkdirSync(join(root, '.attic/a/tree'));
    put(root, 't/target-shared/CACHEDIR.TAG');
    mkdirSync(join(root, 'u/target-shared'), { recursive: true });
    expect(trees(root).sort()).toEqual(['a/tree', 't/target-shared', 'x/y/z/tree'].map(p => join(root, p)));
  });
});

describe('room', () => {
  it('collects, then refuses with the held cache and the command that frees it', async () => {
    await faked(box, async () => {
      await expect(room({ dir: tmp('disk') }, 0)).resolves.toBeUndefined();
      pin('luna', ['bothub-env/*'], 14);
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
