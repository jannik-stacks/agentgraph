import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { expect, it } from 'vitest';
import { makeSandbox } from '../src/mirror.ts';
import { Runner, Sandbox } from '../src/sandbox.ts';
import { git, tmp } from './kit.ts';

const commit = (dir: string, branch: string, text: string) => {
  git(dir, 'checkout', '-q', '-B', branch);
  writeFileSync(join(dir, 'a.txt'), text);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', text);
  return git(dir, 'rev-parse', 'HEAD');
};

it('fetches base branches from the origin and agentgraph branches from the second remote only', async () => {
  const upstream = tmp('upstream');
  git(upstream, 'init', '-q', '-b', 'main');
  commit(upstream, 'main', 'old');
  const fork = tmp('fork');
  git(fork, 'clone', '-q', upstream, '.');
  const main = commit(upstream, 'main', 'new');
  commit(upstream, 'agentgraph/1', 'theirs');
  const ours = commit(fork, 'agentgraph/1', 'ours');
  const work = commit(fork, 'agentgraph/7', 'work');
  const layer = makeSandbox({ data: tmp('data'), origin: upstream, branches: { origin: fork } }).pipe(
    Layer.provide(Layer.succeed(Runner, { open: () => Effect.die('unused') }))
  );
  const heads = await Effect.runPromise(
    Effect.flatMap(Sandbox, s => Effect.forEach(['main', 'agentgraph/1', 'agentgraph/7'], s.readHead)).pipe(
      Effect.provide(layer)
    )
  );
  expect(heads).toEqual([main, ours, work]);
});
