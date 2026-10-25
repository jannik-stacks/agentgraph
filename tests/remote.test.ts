import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Chunk, Effect, Exit, type Layer, Redacted, type Scope, Stream } from 'effect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { remoteSandbox } from '../src/remote.ts';
import { type Command, Sandbox } from '../src/sandbox.ts';
import { startBoxServer } from './doubles/box.ts';
import { git, tmp } from './kit.ts';

const origin = () => {
  const dir = tmp('origin');
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'old.txt'), 'old\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'old');
  rmSync(join(dir, 'old.txt'));
  writeFileSync(join(dir, 'a.txt'), 'main\n');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'main');
  return dir;
};

const use = <A, E>(layer: Layer.Layer<Sandbox>, f: (s: Sandbox['Type']) => Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromiseExit(Sandbox.pipe(Effect.flatMap(f), Effect.scoped, Effect.provide(layer)));

const sh = (dir: string, script: string, more: Partial<Command> = {}): Command => ({
  cmd: 'sh',
  args: ['-c', script],
  dir,
  env: {},
  network: 'none',
  minutes: 1,
  ...more,
});

describe('remote sandbox', () => {
  const boxes = tmp('boxes');
  let server: Awaited<ReturnType<typeof startBoxServer>>;
  beforeAll(async () => {
    server = await startBoxServer(boxes);
  });
  afterAll(() => server.close());
  const layer = () => remoteSandbox({ url: server.url, data: tmp('data'), origin: origin() });

  it('keeps a written file for the next command and on the host, and deletes travel both ways', async () => {
    const exit = await use(layer(), s =>
      Effect.gen(function* () {
        const work = yield* s.checkout('main');
        const first = yield* s.exec(
          sh(work.dir, 'echo box > b.txt; rm a.txt; mkdir -p node_modules; echo x > node_modules/m')
        );
        const seen = [existsSync(join(work.dir, 'b.txt')), existsSync(join(work.dir, 'a.txt'))];
        writeFileSync(join(work.dir, 'c.txt'), 'host\n');
        rmSync(join(work.dir, 'b.txt'));
        const second = yield* s.exec(sh(work.dir, 'ls; cat node_modules/m; git status --short'));
        return { first, seen, second, ignored: existsSync(join(work.dir, 'node_modules')) };
      })
    );
    expect(exit).toEqual(
      Exit.succeed({
        first: { code: 0, output: '' },
        seen: [true, false],
        second: { code: 0, output: 'c.txt\nnode_modules\nx\n D a.txt\n?? c.txt\n' },
        ignored: false,
      })
    );
  });

  it('seeds a box again after it restarted, from the files the host has', async () => {
    const exit = await use(layer(), s =>
      Effect.gen(function* () {
        const work = yield* s.checkout('main');
        yield* s.exec(sh(work.dir, 'echo kept > b.txt'));
        rmSync(join(boxes, basename(work.dir)), { recursive: true });
        return yield* s.exec(sh(work.dir, 'cat b.txt; git log --format=%s'));
      })
    );
    expect(exit).toEqual(Exit.succeed({ code: 0, output: 'kept\nmain\n' }));
  });

  it('streams lines with the exit code last', async () => {
    const exit = await use(layer(), s =>
      Effect.flatMap(s.checkout('main'), work =>
        Stream.runCollect(s.lines(sh(work.dir, 'echo one; echo two; printf three; exit 3')))
      )
    );
    expect(Exit.map(exit, Chunk.toArray)).toEqual(Exit.succeed(['one', 'two', 'three', { code: 3 }]));
  });

  it('brings the session home, the hub and the news to the box, on the network of its hub', async () => {
    const hub = tmp('hub');
    writeFileSync(join(hub, 'rules.md'), 'rules\n');
    const home = join(tmp('homes'), 'session-1');
    mkdirSync(join(home, '.cache'), { recursive: true });
    writeFileSync(join(home, 'state'), 'one\n');
    writeFileSync(join(home, '.cache', 'big'), 'stays\n');
    const exit = await use(layer(), s =>
      Effect.gen(function* () {
        const work = yield* s.checkout('main', undefined, undefined, { network: 'models' });
        writeFileSync(work.news, 'news\n');
        return yield* s.exec(
          sh(
            work.dir,
            'cat "$HOME/state" "$AGENTGRAPH_HUB/rules.md" "$NEWS"; ls -A "$HOME"; echo two > "$HOME/state"',
            {
              home,
              hub,
              env: { NEWS: work.news },
              network: 'proxy',
            }
          )
        );
      })
    );
    expect(exit).toEqual(Exit.succeed({ code: 0, output: 'one\nrules\nnews\nstate\n' }));
    expect(readFileSync(join(home, 'state'), 'utf8')).toBe('two\n');
    expect(server.runs.at(-1)?.network).toBe('models');
  });

  it('runs the toolchain step in the box with network open, once per checkout', async () => {
    const before = server.runs.length;
    const exit = await use(layer(), s =>
      Effect.flatMap(s.checkout('main', undefined, undefined, { toolchain: 'echo tool > /dev/null' }), work =>
        s.exec(sh(work.dir, 'true'))
      )
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(server.runs.slice(before).map(run => run.network)).toEqual(['open', 'none']);
  });

  it('refuses a hub image and a dir it did not check out', async () => {
    const image = await use(layer(), s => s.checkout('main', undefined, undefined, { image: 'other' }));
    const stray = await use(layer(), s => s.exec(sh(tmp('stray'), 'true')));
    expect(String(image)).toContain('one image');
    expect(String(stray)).toContain('is not a checkout');
  });

  it('destroys the box when the checkout closes', async () => {
    let id = '';
    await use(layer(), s =>
      Effect.flatMap(s.checkout('main'), work => {
        id = basename(work.dir);
        return s.exec(sh(work.dir, 'true'));
      })
    );
    expect(existsSync(join(boxes, id))).toBe(false);
  });

  it('ends a command at its minutes, stops it and brings back what it wrote', async () => {
    const exit = await use(layer(), s =>
      Effect.gen(function* () {
        const work = yield* s.checkout('main');
        const ran = yield* Effect.either(
          s.exec(sh(work.dir, 'echo early > e.txt; sleep 1.5; echo late > l.txt', { minutes: 0.015 }))
        );
        yield* Effect.sleep('1800 millis');
        const after = yield* s.exec(sh(work.dir, 'ls'));
        return [String(ran).includes('timeout'), existsSync(join(work.dir, 'e.txt')), after.output];
      })
    );
    expect(exit).toEqual(Exit.succeed([true, true, 'a.txt\ne.txt\n']));
  });

  it('passes secrets by environment, never in arguments', async () => {
    const exit = await use(layer(), s =>
      Effect.flatMap(s.checkout('main'), work =>
        s.exec(sh(work.dir, 'echo "$TOKEN"', { secrets: { TOKEN: Redacted.make('s3cret') } }))
      )
    );
    expect(exit).toEqual(Exit.succeed({ code: 0, output: 's3cret\n' }));
    expect(JSON.stringify(server.runs.at(-1)?.argv)).not.toContain('s3cret');
  });

  it('brings an ignored file that the host added by force', async () => {
    const exit = await use(layer(), s =>
      Effect.gen(function* () {
        const work = yield* s.checkout('main');
        yield* s.exec(sh(work.dir, 'true'));
        mkdirSync(join(work.dir, 'node_modules'));
        writeFileSync(join(work.dir, 'node_modules', 'forced'), 'forced\n');
        execFileSync('git', ['add', '-f', 'node_modules/forced'], { env: { ...process.env, ...work.git } });
        return yield* s.exec(sh(work.dir, 'cat node_modules/forced'));
      })
    );
    expect(exit).toEqual(Exit.succeed({ code: 0, output: 'forced\n' }));
  });

  it('brings back an ignored file that a command added by force', async () => {
    const exit = await use(layer(), s =>
      Effect.gen(function* () {
        const work = yield* s.checkout('main');
        yield* s.exec(sh(work.dir, 'mkdir node_modules; echo y > node_modules/y; git add -f node_modules/y'));
        const tracked = execFileSync('git', ['ls-files'], { env: { ...process.env, ...work.git } }).toString();
        return [readFileSync(join(work.dir, 'node_modules', 'y'), 'utf8'), tracked];
      })
    );
    expect(exit).toEqual(Exit.succeed(['y\n', '.gitignore\na.txt\nnode_modules/y\n']));
  });

  it('pulls work that did not come back before the next command', async () => {
    const exit = await use(layer(), s =>
      Effect.gen(function* () {
        const work = yield* s.checkout('main');
        server.faults.pulls = 4;
        const failed = yield* Effect.either(s.exec(sh(work.dir, 'echo box > b.txt')));
        const missing = !existsSync(join(work.dir, 'b.txt'));
        const next = yield* s.exec(sh(work.dir, 'cat b.txt'));
        return [failed._tag, missing, next.output, readFileSync(join(work.dir, 'b.txt'), 'utf8')];
      })
    );
    expect(exit).toEqual(Exit.succeed(['Left', true, 'box\n', 'box\n']));
  });

  it('keeps the box when its work never came back', async () => {
    let id = '';
    await use(layer(), s =>
      Effect.flatMap(s.checkout('main'), work => {
        id = basename(work.dir);
        server.faults.pulls = 100;
        return Effect.either(s.exec(sh(work.dir, 'echo box > b.txt')));
      })
    );
    server.faults.pulls = 0;
    expect(readFileSync(join(boxes, id, 'work', 'b.txt'), 'utf8')).toBe('box\n');
  });

  it('fails when the stream ends without an exit code', async () => {
    const mute = await startBoxServer(tmp('boxes'), { frame: false });
    const exit = await use(remoteSandbox({ url: mute.url, data: tmp('data'), origin: origin() }), s =>
      Effect.flatMap(s.checkout('main'), work => s.exec(sh(work.dir, 'true')))
    );
    await mute.close();
    expect(String(exit)).toContain('without an exit code');
  });
});
