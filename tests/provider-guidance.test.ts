import { spawnSync } from 'node:child_process';
import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findLoginProvider } from '../src/status.ts';
import type { Trace } from '../src/trace.ts';
import { git, tmp, write } from './kit.ts';

describe('provider guidance', () => {
  it('finds the provider of the latest failed session by its trace key', () => {
    const trace: Trace[] = [
      {
        at: '1',
        step: 'work',
        key: 'one',
        event: { type: 'start', session: 's1', harness: 'custom', provider: 'original', model: 'm', home: '/tmp' },
      },
      {
        at: '2',
        step: 'work',
        key: 'two',
        event: { type: 'start', session: 's2', harness: 'custom', provider: 'other', model: 'm', home: '/tmp' },
      },
      { at: '3', step: 'work', key: 'one', session: { resumed: false, ended: 'login', usd: 0 } },
      {
        at: '4',
        step: 'work',
        outcome: { kind: 'stop', why: 'login' },
        failure: 'login',
        run: { step: 'work', status: 'stopped', tries: 0, rounds: {} },
      },
    ];
    expect(findLoginProvider(trace, 'work')).toBe('original');
    expect(findLoginProvider(trace, 'other')).toBeUndefined();
    expect(
      findLoginProvider(
        [
          ...trace,
          {
            at: '5',
            step: 'work',
            outcome: { kind: 'stop', why: 'other' },
            failure: 'provider',
            run: { step: 'work', status: 'stopped', tries: 0, rounds: {} },
          },
        ],
        'work'
      )
    ).toBeUndefined();
    expect(
      findLoginProvider(
        [
          ...trace.slice(0, 2),
          { at: '3', step: 'work', session: { resumed: false, ended: 'login', usd: 0 } },
          trace[3]!,
        ],
        'work'
      )
    ).toBeUndefined();
    expect(
      findLoginProvider(
        [
          {
            at: '1',
            step: 'work',
            key: 'one',
            event: { type: 'start', session: 's1', harness: 'custom', model: 'm', home: '/tmp' },
          },
          trace[2]!,
          trace[3]!,
        ],
        'work'
      )
    ).toBeUndefined();
    expect(
      findLoginProvider(
        [
          {
            at: '1',
            step: 'work',
            key: 'one',
            event: { type: 'end', final: '401', ended: 'error', exit: 1, provider: 'original' },
          },
          trace[2]!,
          trace[3]!,
        ],
        'work'
      )
    ).toBe('original');
  });

  it('prints setup instructions from a custom config when no provider is ready', () => {
    const root = tmp('provider-guidance');
    const repo = join(root, 'repo');
    const config = join(root, 'config.mjs');
    write(root, {
      'repo/readme.md': 'repo\n',
      'config.mjs': `export default {
        harnesses: [{ name: 'custom', key: 'CUSTOM_KEY', classify: () => 'read', command: () => ({ cmd: 'true', args: [], input: '' }), parse: () => () => [] }],
        providers: [{ name: 'custom', harnesses: ['custom'], ready: () => false, setup: 'Configure the custom account first.' }]
      };`,
    });
    cpSync(join(import.meta.dirname, '../examples/starter'), join(repo, '.agentgraph'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'initial');
    const result = spawnSync(
      process.execPath,
      [join(import.meta.dirname, '../bin/run.ts'), 'start', 'Fix it', '--repo', repo, '--data', join(root, 'data')],
      {
        encoding: 'utf8',
        env: { ...process.env, AGENTGRAPH_CONFIG: config, HOME: root, NODE_OPTIONS: '' },
      }
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('Configure the custom account first.');
    const selected = spawnSync(
      process.execPath,
      [
        join(import.meta.dirname, '../bin/run.ts'),
        'start',
        'Fix it',
        '--repo',
        repo,
        '--data',
        join(root, 'selected'),
        '--provider',
        'custom',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, AGENTGRAPH_CONFIG: config, HOME: root, NODE_OPTIONS: '' },
      }
    );
    expect(selected.status).not.toBe(0);
    expect(selected.stdout + selected.stderr).toContain('Configure the custom account first.');
  });
});
