import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { hostGit } from '../src/git.ts';
import { tmp, write } from './kit.ts';

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
});
