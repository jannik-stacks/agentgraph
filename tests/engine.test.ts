import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { makeEngineHost } from '../src/engine.ts';
import { getRunOrigin } from '../src/meta.ts';
import { seeded } from './fixtures.ts';
import { git } from './kit.ts';
import { removeAfter } from './world.ts';

it('reads only registered stores and submits runs under its own plugin name', async () => {
  const { root, seed } = seeded('engine-host', { 'README.md': 'hello' });
  removeAfter(root);
  const tracker = join(root, 'tracker');
  git(root, 'init', '-q', '--bare', '-b', 'main', join(tracker, 'origin.git'));
  const configs = [{ name: 'a', data: join(root, 'a') }];
  mkdirSync(join(root, 'a'));
  symlinkSync(join(root, 'a'), join(root, 'alias'));
  expect(() => makeEngineHost('bench', [...configs, { name: 'b', data: join(root, 'alias') }])).toThrow(
    'share the data dir'
  );
  const origin = { job: 'set', version: 'v', input: { case: 'c' }, labels: { arm: 'human' } };
  const submission = { import: { checkout: seed, tracker, change: 'HEAD', from: 'HEAD' } };
  await expect(makeEngineHost('bench', configs).submit('a', origin, submission)).rejects.toThrow(
    'bench cannot submit runs from here'
  );
  const host = makeEngineHost('bench', configs, true);
  await expect(host.submit('b', origin, submission)).rejects.toThrow('no config b; registered: a');
  await expect(host.submit('a', { ...origin, labels: { Bad: 'x' } }, submission)).rejects.toThrow('Bad');
  const [run] = await host.submit('a', origin, submission);
  expect(() => host.readRuns('b')).toThrow('no config b');
  const [stored] = host.readRuns('a');
  expect(stored!.run.id).toBe(run!.id);
  expect(stored!.labels).toEqual({ arm: 'human' });
  expect(getRunOrigin(stored!.run.meta)).toEqual({ plugin: 'bench', version: 'v', job: 'set', input: { case: 'c' } });
});
