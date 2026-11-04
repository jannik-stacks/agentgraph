import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { expect, it } from 'vitest';
import { ensureGraph, ensureInstance, findInstances } from '../src/instance.ts';
import { seeded } from './fixtures.ts';

it('names two independent instances of one checkout within an explicit root', async () => {
  const { root, seed } = seeded('named-instance', { 'file.txt': 'content' });
  const data = join(root, 'instances');
  const live = await ensureInstance(data, 'live', seed);
  const bench = await ensureInstance(data, 'bench', seed);
  expect([live.dir, bench.dir]).toEqual([join(data, 'live'), join(data, 'bench')]);
  expect(findInstances(data).map(i => i.repo)).toEqual([live.repo, live.repo]);
  expect(findInstances(join(root, 'other'))).toEqual([]);
  expect((await ensureInstance(data, 'live', seed)).made).toBe(false);
  await expect(ensureInstance(data, '../escape', seed)).rejects.toThrow('one path component');
  const other = seeded('other-instance', { 'file.txt': 'content' });
  await expect(ensureInstance(data, 'live', other.seed)).rejects.toThrow('belongs to');
});

it('reads every instance field strictly and resolves paths against its folder', async () => {
  const { root, seed } = seeded('instance-fields', { 'file.txt': 'content' });
  const instance = await ensureInstance(join(root, 'instances'), 'live', seed);
  const file = join(instance.dir, 'instance.yaml');
  const record = {
    ...parse(readFileSync(file, 'utf8')),
    slug: 'owner/repository',
    graph: '../../../seed',
    env: '../keys.env',
    loop: true,
    trust: [],
    image: 'sandbox:custom',
    limits: { parallel: 1 },
  };
  writeFileSync(file, stringify(record));
  const [read] = findInstances(join(root, 'instances'));
  expect(read).toMatchObject({
    slug: 'owner/repository',
    env: join(root, 'instances', 'keys.env'),
    loop: true,
    trust: [],
    image: 'sandbox:custom',
    limits: { parallel: 1 },
  });
  writeFileSync(file, stringify({ ...record, unknown: true }));
  expect(() => findInstances(join(root, 'instances'))).toThrow('unknown');
  await expect(ensureGraph({ ...instance, graph: seed })).resolves.toBe(seed);
});
