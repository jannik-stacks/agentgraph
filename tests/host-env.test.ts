import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Fiber } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { hostGit } from '../src/git.ts';
import { git, tmp, write } from './kit.ts';

describe('host git', () => {
  it('passes the variables it needs and none of the engine keys', async () => {
    const dir = tmp('host-env');
    write(dir, { 'bin/git': '#!/bin/sh\nenv\n' });
    chmodSync(join(dir, 'bin', 'git'), 0o755);
    const shell = {
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      AGENTGRAPH_APP_KEY: 'FAKE-canary-pem',
      AGENTGRAPH_PROXY_KEYS: 'implementor=FAKE-canary-key',
      OPENROUTER_API_KEY: 'FAKE-canary-provider',
    };
    const before = { ...process.env };
    Object.assign(process.env, shell);
    try {
      const out = (await Effect.runPromise(hostGit({ GIT_DIR: dir }, ['status']))).toString();
      expect(out).not.toContain('FAKE-canary');
      expect(out).toContain(`PATH=${shell.PATH}`);
      expect(out).toContain(`GIT_DIR=${dir}`);
    } finally {
      for (const name of Object.keys(shell)) delete process.env[name];
      Object.assign(process.env, before);
    }
  });

  it('leaves no index lock behind when it is interrupted', async () => {
    const dir = tmp('host-lock');
    write(dir, { 'a.txt': 'a\n' });
    git(dir, 'init', '-q');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'a');
    writeFileSync(join(dir, 'a.txt'), 'b\n');
    const editing = join(dir, 'editing');
    const env = {
      GIT_DIR: join(dir, '.git'),
      GIT_WORK_TREE: dir,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
      GIT_EDITOR: `touch ${editing}; sleep 60;`,
    };
    const fiber = Effect.runFork(hostGit(env, ['commit', '-a']));
    await vi.waitFor(() => existsSync(editing) || Promise.reject(new Error('git has not opened its editor')), {
      timeout: 30_000,
      interval: 20,
    });
    const locked = existsSync(join(dir, '.git', 'index.lock'));
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect([locked, existsSync(join(dir, '.git', 'index.lock'))]).toEqual([true, false]);
  });
});
