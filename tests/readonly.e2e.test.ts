import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Exit } from 'effect';
import { describe, expect, it } from 'vitest';
import { dockerSandbox, sandboxImage } from '../src/docker.ts';
import { Sandbox } from '../src/sandbox.ts';
import { git, tmp } from './kit.ts';

const up = () =>
  process.env.AGENTGRAPH_E2E === '1' &&
  spawnSync('docker', ['image', 'inspect', sandboxImage], { encoding: 'utf8' }).status === 0;

const tries = `
try() { if sh -c "$1" 2>/dev/null; then echo "$2 ok"; else echo "$2 denied"; fi; }
try 'cat a.txt > /dev/null' read
try 'git status --short && git diff --stat' git
try 'echo x > a.txt' edit
try 'echo x > new.txt' create
try 'echo x > "$(git rev-parse --git-dir)/x"' gitdir
try 'echo x > "$HOME/x"' home
try 'echo x > /tmp/x' tmp
`;

const run = (readonly: boolean) => {
  const origin = tmp('origin');
  git(origin, 'init', '-q', '-b', 'main');
  writeFileSync(join(origin, 'a.txt'), 'main\n');
  git(origin, 'add', '.');
  git(origin, 'commit', '-q', '-m', 'main');
  const home = tmp('home');
  return Effect.runPromiseExit(
    Sandbox.pipe(
      Effect.flatMap(s =>
        Effect.gen(function* () {
          const work = yield* s.checkout('main');
          const out = yield* s.exec({
            cmd: 'sh',
            args: ['-c', tries],
            dir: work.dir,
            home,
            readonly,
            env: {},
            network: 'none',
            minutes: 1,
          });
          return { output: out.output, file: readFileSync(join(work.dir, 'a.txt'), 'utf8') };
        })
      ),
      Effect.scoped,
      Effect.provide(dockerSandbox({ data: tmp('data'), origin, cache: '' }))
    )
  );
};

describe.skipIf(!up())('a read-only command in a real container', () => {
  it('reads and runs git but writes only its home and /tmp', async () => {
    const exit = await run(true);
    expect(Exit.isSuccess(exit) && exit.value).toEqual({
      output: ['read ok', 'git ok', 'edit denied', 'create denied', 'gitdir denied', 'home ok', 'tmp ok', ''].join(
        '\n'
      ),
      file: 'main\n',
    });
  }, 120_000);

  it('writes the work tree when it is not read-only', async () => {
    const exit = await run(false);
    expect(Exit.isSuccess(exit) && exit.value).toMatchObject({ file: 'x\n' });
    expect(Exit.isSuccess(exit) && exit.value.output).toContain('edit ok\ncreate ok\ngitdir ok\n');
  }, 120_000);
});
