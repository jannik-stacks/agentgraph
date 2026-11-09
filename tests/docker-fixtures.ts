import { beforeAll, afterAll } from 'vitest';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { Effect, Layer, Stream } from 'effect';
import { dockerRunner } from '../src/docker.ts';
import { makeSandbox } from '../src/mirror.ts';
import { delimiter, join } from 'node:path';
import { Runner, Sandbox } from '../src/sandbox.ts';
import { git, tmp } from './kit.ts';
import { type Command, type Exit } from '../src/types.ts';

export const dockerSandbox = (o: Parameters<typeof makeSandbox>[0] & Parameters<typeof dockerRunner>[0]) =>
  Layer.effect(
    Sandbox,
    Effect.gen(function* () {
      const sandbox = yield* Sandbox;
      const runner = yield* Runner;
      const dirs = new Set<string>();
      const stray = { dir: '', base: '', git: { GIT_DIR: '', GIT_WORK_TREE: '' }, news: '' };
      const lines = (c: Command) =>
        dirs.has(c.dir) ? sandbox.lines(c) : Stream.unwrap(Effect.map(runner.open(stray), box => box.lines(c)));
      return {
        ...sandbox,
        checkout: (...args) => Effect.tap(sandbox.checkout(...args), work => Effect.sync(() => dirs.add(work.dir))),
        tools: dir =>
          dirs.has(dir)
            ? sandbox.tools!(dir)
            : Effect.scoped(Effect.flatMap(runner.open(stray), box => box.tools!(dir))),
        lines,
        exec: c =>
          dirs.has(c.dir)
            ? sandbox.exec(c)
            : Effect.scoped(
                Stream.runFold(
                  lines(c),
                  (): Exit => ({ code: 0, output: '' }),
                  (exit, piece) =>
                    typeof piece === 'string' ? { ...exit, output: exit.output + piece + '\n' } : { ...exit, ...piece }
                )
              ),
      } satisfies Sandbox['Service'];
    })
  ).pipe(Layer.provide(makeSandbox(o)), Layer.provideMerge(dockerRunner(o)));

export const makeDockerOrigin = () => {
  const dir = tmp('origin');
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'main\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'main');
  git(dir, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(dir, 'a.txt'), 'feature\n');
  git(dir, 'commit', '-q', '-am', 'feature');
  git(dir, 'checkout', '-q', 'main');
  return dir;
};

export const makeDockerCommand = (dir: string, more: Partial<Command> = {}): Command => ({
  cmd: 'sh',
  args: ['-c', 'echo hi'],
  dir,
  env: { A: '1' },
  network: 'none',
  minutes: 1,
  ...more,
});

export const makeDockerClient = () => {
  const bin = tmp('bin');
  const log = join(bin, 'log');
  const path = process.env.PATH;
  beforeAll(() => {
    writeFileSync(
      join(bin, 'docker'),
      [
        '#!/bin/sh',
        'case "$*" in *"printf agentgraph-command-ready"*) printf agentgraph-command-ready; exit 0;; esac',
        `[ "$1" = network ] && { echo "$*" >> ${log}.network; case "$*" in *tools-fail.internal*) exit 4;; *IPAM.Config*) echo '[{"Gateway":"172.30.0.1","Subnet":"172.30.0.0/16"}]'; exit 0;; esac; echo true; exit 0; }`,
        `[ "$1" = rm ] && { sleep 0.2; : > ${log}.held; echo "$*" >> ${log}.rm; exit 0; }`,
        `[ "$1" = image ] && case "$*" in *Labels*) [ -e ${log}.imgfail ] && { echo "Cannot connect to the Docker daemon" >&2; exit 1; }; echo "Error: No such image" >&2; exit 1;; *) echo sha256:base; exit 0;; esac`,
        `[ "$1 $2" = "volume inspect" ] && for a; do case $a in agentgraph-*) echo /m/$a;; esac; done`,
        `[ "$1 $2" = "volume ls" ] && { case "$*" in *label=agentgraph.lower=*) rm ${log}.lsfail 2>/dev/null && exit 1;; esac; for a; do case $a in label=agentgraph.*) f=\${a#label=};; esac; done; [ -f ${log}.live ] && while read -r p o; do case "$f" in "$p"*) echo "$f,$o";; esac; done < ${log}.live; exit 0; }`,
        `[ "$1 $2" = "volume rm" ] && for a; do grep -qx -- "$a" ${log}.held 2>/dev/null && { echo "volume $a is in use" >&2; exit 1; }; done`,
        `case "$*" in *agentgraph.envbuild=1*) for a; do case $a in type=volume,src=*) v=\${a#type=volume,src=}; echo "\${v%%,*}" >> ${log}.held;; esac; done;; esac`,
        `case "$1" in commit|volume) echo "$*" >> ${log}.all; exit 0;; esac`,
        `printf '%s\\n' "$@" > ${log}`,
        `echo "$*" >> ${log}.all`,
        `echo "secret=\${AGENTGRAPH_LLM_API_KEY:-unset}" >> ${log}`,
        `echo line one; echo line two >&2`,
        `case "$*" in *"skelfail deps"*) exit 98;; *"skeltool x deps"*) exit 97;; *"skelfail tree"*) ;; *exit125*) exit 125;; *measured*) printf '\\nagentgraph-used 104857600 usage_usec 2500000 oom_kill 0\\n';; *interleaved*) printf '\\nagentgraph-used 1048576 usage_usec 2000 oom_kill 0\\nafter\\n';; *oomed*) printf '\\nagentgraph-used 67108864 usage_usec 1500 oom_kill 1\\n'; exit 137;; *chatty*) while :; do echo tick; sleep 0.05; done;; *sleep*) sleep 5;; *toolfail*) exit 97;; *fail*) exit 3;; *withdeps*) printf '@@ignored\\nnode_modules/\\n@@untracked\\n@@lower\\n5\\n';; esac`,
        `case "$*" in *agentgraph.envbuild*) printf '@@ignored\\n@@untracked\\n@@lower\\n0\\n';; esac`,
      ].join('\n')
    );
    chmodSync(join(bin, 'docker'), 0o755);
    process.env.PATH = `${bin}${delimiter}${path}`;
  });
  afterAll(() => {
    process.env.PATH = path;
  });

  const layer = dockerSandbox({ data: tmp('data'), origin: '/nowhere', direct: ['gateway'] });
  const logged = () => readFileSync(log, 'utf8').split('\n');

  return { log, layer, logged };
};
