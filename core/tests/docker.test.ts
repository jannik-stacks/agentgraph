import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Chunk, Effect, Exit, Layer, Redacted, Stream } from 'effect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { docker } from '../src/docker.ts';
import { harnesses } from '../src/harnesses.ts';
import { type Command, Sandbox } from '../src/sandbox.ts';
import { Session } from '../src/session.ts';

const tmp = (name: string) => mkdtempSync(join(tmpdir(), `core-${name}-`));

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd: dir,
    encoding: 'utf8',
  }).trim();

/** A repo with one commit on `main` and a `feature` branch one commit ahead. */
const origin = () => {
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

const use = <A, E>(
  layer: Layer.Layer<Sandbox>,
  f: (s: Sandbox['Type']) => Effect.Effect<A, E, import('effect').Scope.Scope>
) => Effect.runPromiseExit(Sandbox.pipe(Effect.flatMap(f), Effect.scoped, Effect.provide(layer)));

const command = (dir: string, more: Partial<Command> = {}): Command => ({
  cmd: 'sh',
  args: ['-c', 'echo hi'],
  dir,
  env: { A: '1' },
  network: 'none',
  minutes: 1,
  ...more,
});

/**
 * What a session could leave in its worktree to steer host git: a `.git` pointing at its own repo whose config runs a
 * script through fsmonitor, a clean filter and hooks, and, given the admin dir, a commondir and gitdir pointing away.
 * The script touches `marker`.
 */
const plant = (dir: string, admin?: string) => {
  const evil = tmp('evil');
  const marker = join(evil, 'marker');
  const script = join(evil, 'run.sh');
  writeFileSync(script, `#!/bin/sh\ntouch ${marker}\ncat\n`);
  chmodSync(script, 0o755);
  git(evil, 'init', '-q', '--bare');
  for (const [key, value] of [
    ['core.fsmonitor', script],
    ['core.hooksPath', join(evil, 'hooks')],
    ['filter.evil.clean', script],
    ['filter.evil.required', 'true'],
  ] as const)
    git(evil, 'config', key, value);
  mkdirSync(join(evil, 'hooks'), { recursive: true });
  for (const hook of ['pre-commit', 'post-commit', 'reference-transaction', 'post-checkout', 'post-index-change'])
    writeFileSync(join(evil, 'hooks', hook), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  writeFileSync(join(dir, '.git'), `gitdir: ${evil}\n`);
  writeFileSync(join(dir, '.gitattributes'), '* filter=evil\n');
  const victim = tmp('victim');
  writeFileSync(join(victim, 'keep.txt'), 'mine\n');
  if (admin) {
    writeFileSync(join(admin, 'commondir'), `${evil}\n`);
    writeFileSync(join(admin, 'gitdir'), `${join(victim, '.git')}\n`);
  }
  return { marker, victim };
};

describe('docker with a stand-in docker client', () => {
  const bin = tmp('bin');
  const log = join(bin, 'log');
  const path = process.env.PATH;
  beforeAll(() => {
    writeFileSync(
      join(bin, 'docker'),
      [
        '#!/bin/sh',
        `[ "$1" = network ] && { echo true; exit 0; }`,
        `[ "$1" = rm ] && exit 0`,
        `printf '%s\\n' "$@" > ${log}`,
        `echo "secret=\${BOTHUB_LLM_API_KEY:-unset}" >> ${log}`,
        `echo line one; echo line two >&2`,
        `case "$*" in *exit125*) exit 125;; *sleep*) sleep 5;; *fail*) exit 3;; esac`,
      ].join('\n')
    );
    chmodSync(join(bin, 'docker'), 0o755);
    process.env.PATH = `${bin}${delimiter}${path}`;
  });
  afterAll(() => {
    process.env.PATH = path;
  });

  const layer = docker({ data: tmp('data'), origin: '/nowhere' });
  const logged = () => readFileSync(log, 'utf8').split('\n');

  it('runs a hardened container with secrets by name and their values only in the client env', async () => {
    const dir = tmp('work');
    const home = tmp('home');
    const exit = await use(layer, s =>
      s.exec(
        command(dir, { home, network: 'proxy', secrets: { BOTHUB_LLM_API_KEY: Redacted.make('sk-value-123456') } })
      )
    );
    expect(exit).toEqual(Exit.succeed({ code: 0, output: 'line one\nline two\n' }));
    const args = logged();
    for (const flag of ['--rm', '--read-only', '--cap-drop=ALL', 'no-new-privileges=true', '--pull', 'never'])
      expect(args).toContain(flag);
    expect(args[args.indexOf('--network') + 1]).toBe('bothub-sandbox');
    expect(args).toContain(`type=bind,src=${dir},dst=/work`);
    expect(args).toContain(`type=bind,src=${home},dst=/home/agent`);
    expect(args).toContain('HOME=/home/agent');
    expect(args).toContain('HTTPS_PROXY=http://egress:8888');
    expect(args).toContain('A=1');
    expect(args.slice(args.indexOf('BOTHUB_LLM_API_KEY') - 1, args.indexOf('BOTHUB_LLM_API_KEY') + 1)).toEqual([
      '-e',
      'BOTHUB_LLM_API_KEY',
    ]);
    expect(args.join(' ')).not.toContain('sk-value-123456=');
    expect(args.filter(a => a.includes('sk-value'))).toEqual(['secret=sk-value-123456']);
    expect(args.slice(-6, -2)).toEqual(['bothub-sandbox:local', 'sh', '-c', 'echo hi']);
  });

  it('has no network without the proxy and returns any exit code', async () => {
    const exit = await use(layer, s => s.exec(command(tmp('work'), { args: ['-c', 'fail'] })));
    expect(Exit.isSuccess(exit) && exit.value.code).toBe(3);
    const args = logged();
    expect(args[args.indexOf('--network') + 1]).toBe('none');
    expect(args.join('\n')).not.toContain('HTTPS_PROXY');
  });

  it('streams lines until the process exits, whatever its code', async () => {
    const exit = await use(layer, s => Stream.runCollect(s.lines(command(tmp('work'), { args: ['-c', 'fail'] }))));
    expect(Exit.map(exit, Chunk.toArray)).toEqual(Exit.succeed(['line one', 'line two']));
  });

  it('fails as infra when docker cannot start the container', async () => {
    const exit = await use(layer, s => s.exec(command(tmp('work'), { args: ['-c', 'exit125'] })));
    expect(JSON.stringify(exit)).toContain('"reason":"infra"');
  });

  it('fails as a timeout when the command runs past its minutes', async () => {
    const exit = await use(layer, s => s.exec(command(tmp('work'), { args: ['-c', 'sleep'], minutes: 0.01 })));
    expect(JSON.stringify(exit)).toContain('"reason":"timeout"');
  });

  it('mounts no git dir a work tree names, only the ones recorded for a checkout', async () => {
    const dir = tmp('work');
    writeFileSync(join(dir, '.git'), 'gitdir: /tmp/x\n');
    await use(layer, s => s.exec(command(dir)));
    expect(logged().join('\n')).not.toContain('/tmp/x');

    const data = tmp('data');
    const exit = await use(docker({ data, origin: origin() }), s =>
      Effect.gen(function* () {
        const work = yield* s.checkout('main');
        writeFileSync(join(work.dir, '.git'), 'gitdir: /tmp/x\n');
        yield* s.exec(command(work.dir));
        return logged().filter(a => a.startsWith('type=bind'));
      })
    );
    const mirror = join(data, 'mirror.git');
    const binds = Exit.isSuccess(exit) ? exit.value : [];
    expect(binds.join('\n')).not.toContain('/tmp/x');
    expect(binds).toHaveLength(3);
    expect(binds[1]).toMatch(new RegExp(`^type=bind,src=(/private)?${mirror},dst=.*,readonly$`));
    expect(binds[2]).toMatch(new RegExp(`^type=bind,src=(/private)?${mirror}/worktrees/\\w+,dst=`));
  });

  it('refuses to mount a docker socket', async () => {
    const exit = await use(layer, s => s.exec(command('/var/run/docker.sock')));
    expect(JSON.stringify(exit)).toContain('mount not allowed');
  });
});

describe('docker checkout', () => {
  it('sends the token to clone and fetch through the environment only', async () => {
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const bin = tmp('git-bin');
    const log = join(bin, 'log');
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\necho "argv $*" >> ${log}\necho "env $GIT_CONFIG_COUNT $GIT_CONFIG_KEY_0 $GIT_CONFIG_VALUE_0" >> ${log}\nexec ${real} "$@"\n`
    );
    chmodSync(join(bin, 'git'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${path}`;
    const data = tmp('data');
    const token = 'ghs_secret_token_value';
    const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    try {
      const layer = docker({ data, origin: origin(), token: Effect.succeed(token) });
      const exit = await use(layer, s => Effect.zipRight(s.checkout('main'), s.checkout('main')));
      expect(Exit.isSuccess(exit)).toBe(true);
    } finally {
      process.env.PATH = path;
    }
    const lines = readFileSync(log, 'utf8').split('\n');
    const authed = lines.flatMap((line, i) =>
      line.startsWith('argv') && /clone|fetch/.test(line) ? [lines[i + 1]] : []
    );
    expect(authed).toEqual([
      `env 1 http.https://github.com/.extraheader ${header}`,
      `env 1 http.https://github.com/.extraheader ${header}`,
    ]);
    const rest = lines.flatMap((line, i) =>
      line.startsWith('argv') && !/clone|fetch/.test(line) ? [lines[i + 1]] : []
    );
    expect(rest.every(line => !line?.includes('extraheader'))).toBe(true);
    const argv = lines.filter(line => line.startsWith('argv')).join('\n');
    expect(argv).not.toContain(token);
    expect(argv).not.toContain(header.split(' ').at(-1));
    const config = readFileSync(join(data, 'mirror.git', 'config'), 'utf8');
    expect(config).not.toContain(header.split(' ').at(-1));
    expect(config).not.toContain(token);
    expect(config).not.toContain('extraheader');
  }, 30_000);

  it('checks out a ref or the existing branch from a mirror and removes the worktree with the scope', async () => {
    const data = tmp('data');
    const layer = docker({ data, origin: origin() });
    let kept = '';
    const exit = await use(layer, s =>
      Effect.gen(function* () {
        const main = yield* s.checkout('main');
        const feature = yield* s.checkout('main', 'feature');
        const fresh = yield* s.checkout('main', 'missing');
        kept = main.dir;
        return [main, feature, fresh].map(c => [
          readFileSync(join(c.dir, 'a.txt'), 'utf8').trim(),
          c.base === git(c.dir, 'rev-parse', 'HEAD'),
        ]);
      })
    );
    expect(exit).toEqual(
      Exit.succeed([
        ['main', true],
        ['feature', true],
        ['main', true],
      ])
    );
    expect(existsSync(kept)).toBe(false);
    expect(existsSync(join(data, 'mirror.git', 'HEAD'))).toBe(true);
  }, 30_000);

  it('keeps the files under the keep ref through a fetch and puts them back on the next checkout', async () => {
    const data = tmp('data');
    const layer = docker({ data, origin: origin() });
    const keep = 'refs/bothub/runs/r1';
    const first = await use(layer, s =>
      Effect.map(s.checkout('main', 'feature', keep), c => writeFileSync(join(c.dir, 'b.txt'), 'kept\n'))
    );
    expect(Exit.isSuccess(first)).toBe(true);
    const second = await use(layer, s =>
      Effect.map(s.checkout('main', undefined, keep), c => [
        readFileSync(join(c.dir, 'a.txt'), 'utf8').trim(),
        readFileSync(join(c.dir, 'b.txt'), 'utf8').trim(),
        c.base === git(c.dir, 'rev-parse', 'refs/heads/feature'),
      ])
    );
    expect(second).toEqual(Exit.succeed(['feature', 'kept', true]));
    expect(git(join(data, 'mirror.git'), 'rev-list', '--count', keep)).toBe('4');
  }, 30_000);

  it('puts kept files on the run branch after the branch moved on', async () => {
    const data = tmp('data');
    const repo = origin();
    const layer = docker({ data, origin: repo });
    const keep = 'refs/bothub/runs/r2';
    await use(layer, s =>
      Effect.map(s.checkout('main', 'work', keep), c => writeFileSync(join(c.dir, 'b.txt'), 'second try\n'))
    );
    git(repo, 'checkout', '-q', '-b', 'work', 'main');
    writeFileSync(join(repo, 'b.txt'), 'first try\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'pushed');
    const tip = git(repo, 'rev-parse', 'work');
    const again = await use(layer, s =>
      Effect.map(s.checkout('main', 'work', keep), c => [
        readFileSync(join(c.dir, 'b.txt'), 'utf8').trim(),
        c.base === tip,
      ])
    );
    expect(again).toEqual(Exit.succeed(['second try', true]));
  }, 30_000);

  it('keeps the files through host git that nothing in the worktree can steer', async () => {
    const data = tmp('data');
    const keep = 'refs/bothub/runs/r3';
    const mirror = join(data, 'mirror.git');
    let planted = { marker: '', victim: '' };
    let dir = '';
    const exit = await use(docker({ data, origin: origin() }), s =>
      Effect.map(s.checkout('main', undefined, keep), c => {
        dir = c.dir;
        writeFileSync(join(c.dir, 'b.txt'), 'kept\n');
        const admin = readFileSync(join(c.dir, '.git'), 'utf8').slice('gitdir: '.length).trim();
        planted = plant(c.dir, admin);
      })
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(existsSync(planted.marker)).toBe(false);
    expect(readFileSync(join(planted.victim, 'keep.txt'), 'utf8')).toBe('mine\n');
    expect(existsSync(dir)).toBe(false);
    expect(git(mirror, 'show', `${keep}:b.txt`)).toBe('kept');
    expect(git(mirror, 'worktree', 'list', '--porcelain')).not.toContain(dir);
  }, 30_000);

  it('fails for a ref that does not exist', async () => {
    const exit = await use(docker({ data: tmp('data'), origin: origin() }), s => s.checkout('nope'));
    expect(JSON.stringify(exit)).toContain('no commit for nope');
  });
});

/** Real containers: `BOTHUB_DOCKER=1` with the bothub-sandbox network and the bothub-sandbox:local image present. */
describe.runIf(process.env.BOTHUB_DOCKER === '1')('docker for real', () => {
  it('runs a command in the sandbox image with no network', async () => {
    const dir = tmp('work');
    writeFileSync(join(dir, 'x.txt'), 'inside\n');
    const exit = await use(docker({ data: tmp('data'), origin: '/nowhere' }), s =>
      s.exec(command(dir, { args: ['-c', 'cat x.txt; id -u; touch /etc/x 2>/dev/null || echo read-only'] }))
    );
    expect(Exit.isSuccess(exit) && exit.value.output).toMatch(/^inside\n\d+\nread-only\n$/);
  }, 60_000);
});

/**
 * One real opencode session in docker against the model proxy: `BOTHUB_LIVE=1` and `BOTHUB_PROXY_KEYS` holding a key
 * for `implementor`. Uses the `fast` alias unless `BOTHUB_LIVE_MODEL` names another.
 */
describe.runIf(process.env.BOTHUB_LIVE === '1')('opencode for real', () => {
  it('answers, is denied a read outside the allowlist, and resumes', async () => {
    const dir = tmp('work');
    writeFileSync(join(dir, 'note.txt'), 'the word is kumquat\n');
    const layer = harnesses({
      data: tmp('data'),
      proxy: { url: 'http://litellm:4000/v1', keys: Redacted.make(process.env.BOTHUB_PROXY_KEYS ?? '') },
      prices: join(import.meta.dirname, '../../infra/local/prices.json'),
    }).pipe(Layer.provide(docker({ data: tmp('data'), origin: '/nowhere' })));
    const open = (prompt: string, resume?: { id: string; home: string }) =>
      Effect.runPromise(
        Session.pipe(
          Effect.flatMap(s =>
            Stream.runCollect(
              s.open({
                harness: 'opencode',
                bot: 'implementor',
                model: process.env.BOTHUB_LIVE_MODEL ?? 'fast',
                system: 'You are a terse assistant. Use tools when asked.',
                prompt,
                dir,
                tools: ['read', 'bash(git status*)'],
                minutes: 5,
                ...(resume && { resume }),
              })
            )
          ),
          Effect.map(Chunk.toArray),
          Effect.scoped,
          Effect.provide(layer)
        )
      );
    const first = await open(
      'Read note.txt, then run the bash command `ls /` even if you expect it to fail. Then say the word from the note.'
    );
    if (process.env.BOTHUB_LIVE_OUT) writeFileSync(process.env.BOTHUB_LIVE_OUT, JSON.stringify(first, null, 1));
    const start = first.find(e => e.type === 'start');
    const end = first.at(-1);
    expect(start).toMatchObject({ type: 'start' });
    expect(first.some(e => e.type === 'usage' && (e.usd ?? 0) > 0)).toBe(true);
    expect(first).toContainEqual(expect.objectContaining({ type: 'tool', name: 'bash', denied: true }));
    expect(end).toMatchObject({ type: 'end', ended: 'stop', exit: 0 });
    expect(end?.type === 'end' && end.final.toLowerCase()).toContain('kumquat');
    if (start?.type !== 'start') return;
    const second = await open('What was the word? Answer with the word only.', { id: start.session, home: start.home });
    expect(second.find(e => e.type === 'start')).toMatchObject({ session: start.session });
    expect(second.at(-1)).toMatchObject({ type: 'end', ended: 'stop', exit: 0 });
    if (process.env.BOTHUB_LIVE_OUT) writeFileSync(`${process.env.BOTHUB_LIVE_OUT}.2`, JSON.stringify(second, null, 1));
  }, 600_000);
});
