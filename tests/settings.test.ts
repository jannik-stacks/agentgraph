import { expect, it } from 'vitest';
import { getSettings } from '../src/settings.ts';
import { makeTestGraph } from './fixtures.ts';

const graph = { ...makeTestGraph('kit'), image: 'graph' };
const instance = {
  repo: 'owner/repository',
  owner: 'owner',
  image: 'instance',
  limits: { parallel: 3 },
  base: 'instance',
};

it.each([
  ['graph defaults', {}, undefined, {}, { repo: '', image: 'graph', parallel: 2 }],
  [
    'instance defaults',
    instance,
    undefined,
    {},
    { repo: 'owner/repository', trust: ['owner'], image: 'instance', parallel: 3, base: 'instance' },
  ],
  ['workflow base', instance, { base: 'workflow' }, {}, { base: 'workflow' }],
  ['explicit empty trust', { ...instance, trust: [] }, undefined, {}, { trust: [] }],
  [
    'command overrides',
    instance,
    { base: 'workflow' },
    { repo: 'other/repository', trust: ['other'], image: 'command', parallel: 4, base: 'command' },
    { repo: 'other/repository', trust: ['other'], image: 'command', parallel: 4, base: 'command' },
  ],
] satisfies [
  string,
  Parameters<typeof getSettings>[1],
  Parameters<typeof getSettings>[2],
  Parameters<typeof getSettings>[3],
  Partial<ReturnType<typeof getSettings>>,
][])('resolves %s', (_name, record, workflow, flags, expected) => {
  expect(getSettings(graph, record, workflow, flags)).toMatchObject(expected);
});
