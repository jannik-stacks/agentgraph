import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Layer } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { fileForge, type Proposal } from '../src/forge.ts';
import { start as main } from '../src/main.ts';
import { host } from '../src/sandbox.ts';
import type { Settings } from '../src/services.ts';
import { scripted, type SessionEvent } from '../src/session.ts';
import { fileStore } from '../src/store.ts';
import { git, tmp } from './fixtures.ts';

const cli = join(import.meta.dirname, '..', 'bin', 'forge.ts');
const sandboxHub = join(import.meta.dirname, '..', 'examples', 'sandbox');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.BOTHUB_FORGE;
  delete process.env.BOTHUB_PROXY_KEYS;
});

const start = (session: string): SessionEvent => ({ type: 'start', session, model: 'test', home: `/homes/${session}` });
const write = (path: string, content: string): SessionEvent => ({
  type: 'tool',
  id: path,
  name: 'write',
  input: { path, content },
  ok: true,
});
const reply = (...proposals: Proposal[]): SessionEvent => ({
  type: 'end',
  final: `Done.\n\n\`\`\`bothub\n${proposals.map(p => JSON.stringify(p)).join('\n')}\n\`\`\``,
  ended: 'stop',
  exit: 0,
});

/** A repo to seed from, a forge folder and a data dir; `forge` runs bin/forge.ts as morgan, `run` sweeps once. */
const world = () => {
  const root = tmp('forge-cli');
  dirs.push(root);
  const seed = join(root, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  writeFileSync(join(seed, 'package.json'), JSON.stringify({ scripts: { test: '! grep -q TODO hello.txt' } }));
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'init');
  const dir = join(root, 'forge');
  const data = join(root, 'data');
  const forge = (...args: string[]) => {
    const r = spawnSync(process.execPath, [cli, dir, ...args, '--as', 'morgan'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  };
  Object.assign(process.env, { BOTHUB_FORGE: dir, BOTHUB_PROXY_KEYS: 'implementor=k1,reviewer=k2' });
  const seen: Settings[] = [];
  const run = (turns: SessionEvent[][], issue: number | 'all' = 'all') =>
    main({ hub: sandboxHub, issue, data }, s => {
      seen.push(s);
      const forgeDir = s.forge as string;
      return Layer.mergeAll(
        fileForge(forgeDir),
        fileStore(s.data),
        host(join(forgeDir, 'origin.git')),
        scripted(turns)
      );
    });
  return { root, seed, dir, origin: join(dir, 'origin.git'), forge, run, seen };
};

describe('bin/forge.ts with run --forge', () => {
  it('files an issue, runs it to a pull request, sends it back from the pull request, and merges', async () => {
    const w = world();
    w.forge('init', w.seed);
    writeFileSync(join(w.root, 'body.md'), 'Add hello.txt.\n');
    expect(w.forge('issue', 'Add a greeting', '--body', join(w.root, 'body.md'))).toBe('#1');
    w.forge('comment', '1', '/bothub');

    const push = (message: string): Proposal => ({ kind: 'push', branch: 'bothub/1', message });
    const pull: Proposal = {
      kind: 'pull_request',
      branch: 'bothub/1',
      base: 'main',
      title: 'Add hello',
      body: 'Adds hello.txt.',
    };
    const first = await w.run([
      [start('i'), write('hello.txt', 'hello\n'), reply(push('feat: add hello'), pull)],
      [start('r'), reply({ kind: 'comment', body: 'Looks right.' })],
    ]);
    expect(w.seen[0]!.forge).toBe(w.dir);
    expect(first.map(r => [r.step, r.status])).toEqual([['merge', 'waiting']]);
    expect(readFileSync(join(w.dir, '2', 'diff.patch'), 'utf8')).toContain('+hello');
    expect(w.forge('show')).toBe('#1 open Add a greeting [bothub:waiting]\n#2 open Add hello (bothub/1 into main)');

    w.forge('comment', '2', '/bothub say hello world');
    const second = await w.run([
      [start('i'), write('hello.txt', 'hello world\n'), reply(push('fix: say hello world'))],
      [start('r'), reply({ kind: 'comment', body: 'Looks right.' })],
    ]);
    expect(second.map(r => [r.step, r.status])).toEqual([['merge', 'waiting']]);
    expect(w.forge('show', '2')).toContain('+hello world');

    expect(w.forge('merge', '2')).toMatch(/^main at [0-9a-f]{40}$/);
    expect(git(w.origin, 'show', 'main:hello.txt')).toBe('hello world');
    expect(w.forge('show')).toBe('#1 closed Add a greeting [bothub:waiting]\n#2 merged Add hello (bothub/1 into main)');
    const last = await w.run([], 1);
    expect(last.map(r => [r.status, r.reason])).toEqual([['stopped', 'closed']]);
  }, 60_000);

  it('runs a stacked issue on the pull request of the one it stacks on', async () => {
    const w = world();
    w.forge('init', w.seed);
    w.forge('issue', 'Add a greeting');
    writeFileSync(join(w.root, 'body.md'), 'Add bye.txt.\n\nStacks on #1\n');
    w.forge('issue', 'Say bye', '--body', join(w.root, 'body.md'));
    w.forge('comment', '1', '/bothub');
    w.forge('comment', '2', '/bothub');
    const turn = (n: number, file: string): SessionEvent[][] => [
      [
        start(`i${n}`),
        write(file, `${file}\n`),
        reply(
          { kind: 'push', branch: `bothub/${n}`, message: `feat: add ${file}` },
          { kind: 'pull_request', branch: `bothub/${n}`, base: 'main', title: `Add ${file}`, body: `Adds ${file}.` }
        ),
      ],
      [start(`r${n}`), reply({ kind: 'comment', body: 'Looks right.' })],
    ];
    await w.run([...turn(1, 'hello.txt'), ...turn(2, 'bye.txt')]);
    expect(w.forge('show')).toContain('#3 open Add hello.txt (bothub/1 into main)');
    expect(w.forge('show')).toContain('#4 open Add bye.txt (bothub/2 into bothub/1)');

    w.forge('merge', '3');
    expect(w.forge('show')).toContain('#4 open Add bye.txt (bothub/2 into main)');
    w.forge('merge', '4');
    expect(git(w.origin, 'show', 'main:bye.txt')).toBe('bye.txt');
    expect(existsSync(join(w.dir, '2.md'))).toBe(true);
  }, 60_000);
});
