import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readArgs } from '../src/cli.ts';
import { git, tmp } from './kit.ts';

const runTs = join(import.meta.dirname, '..', 'bin', 'run.ts');

afterEach(() => vi.restoreAllMocks());

const quietly = (argv: string[]) => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  return readArgs(argv, '1.2.3');
};

describe('agi arguments', () => {
  it.each([
    [['merge', '3'], { verb: 'merge', rest: ['3'], values: { data: undefined } }],
    [['merge', '3', '--data', '/d', '--read-only'], { verb: 'merge', values: { data: '/d', 'read-only': true } }],
    [
      ['--dir', 'g', 'check', 'tests', '--runs', '--issue', '4'],
      { verb: 'check', rest: ['tests'], values: { dir: 'g', runs: true, issue: '4' } },
    ],
    [['loop', '--once', '--logs', 'off'], { verb: 'loop', values: { once: true, logs: 'off' } }],
    [['loop'], { verb: 'loop', values: { once: false } }],
    [['export', '3', '--as', 'mine', '--patch', 'p.diff'], { verb: 'export', values: { as: 'mine', patch: 'p.diff' } }],
    [
      ['dispatch', '3', 'go', '--workflow', 'w', '--step', 's'],
      { verb: 'dispatch', rest: ['3', 'go'], values: { workflow: 'w', step: 's' } },
    ],
    [['resume', '--parked'], { verb: 'resume', rest: [], values: { parked: true } }],
    [['prune-logs', '--apply'], { verb: 'prune-logs', values: { apply: true } }],
    [['say', '3', 'hi', '--line', 'a.ts:1', '--label', 'x'], { verb: 'say', values: { line: 'a.ts:1', label: ['x'] } }],
    [
      ['start', 'Fix it', '--label', 'a', '--label', 'b', '--workflow', 'w'],
      { verb: 'start', rest: ['Fix it'], values: { label: ['a', 'b'], workflow: 'w' } },
    ],
    [['start', 'Fix it'], { verb: 'start', values: { label: undefined } }],
    [
      [
        'show',
        '--provider',
        'p',
        '--harness',
        'h',
        '--model',
        'm',
        '--save',
        '--base',
        'main',
        '--repo',
        'r',
        '--tracker',
        'f',
      ],
      {
        verb: 'show',
        values: { provider: 'p', harness: 'h', model: 'm', save: true, base: 'main', repo: 'r', tracker: 'f' },
      },
    ],
    [
      ['start', 'Fix it', '--run-label', 'arm=v2', '--run-label', 'old-'],
      { verb: 'start', rest: ['Fix it'], values: { 'run-label': ['arm=v2', 'old-'] } },
    ],
    [['start', 'Fix it'], { verb: 'start', values: { 'run-label': undefined } }],
    [['label', 'run-1', 'arm=v2', 'old-'], { verb: 'label', rest: ['run-1', 'arm=v2', 'old-'] }],
    [['label', 'run-1'], { verb: 'label', rest: ['run-1'] }],
    [
      ['import', 'HEAD', 'issue.md', '--from', 'HEAD~1', '--meta', 'm.json'],
      { verb: 'import', rest: ['HEAD', 'issue.md'], values: { from: 'HEAD~1', meta: 'm.json' } },
    ],
    [['import', 'p.diff'], { verb: 'import', rest: ['p.diff'], values: { from: undefined, meta: undefined } }],
    [['--tracker', 'github', 'loop', '--tracker', '/local'], { verb: 'loop', values: { tracker: '/local' } }],
    [['loop', '--tracker', 'a', '--tracker', 'b'], { verb: 'loop', values: { tracker: 'b' } }],
    [
      ['--data', 'd1', '--data', 'd2', 'show', '--dir', 'g1', '--dir=g2'],
      { verb: 'show', values: { data: 'd2', dir: 'g2' } },
    ],
    [
      [
        'start',
        'x',
        '--workflow',
        'a',
        '--label',
        'l1',
        '--workflow',
        'b',
        '--label',
        'l2',
        '--run-label',
        'k=1',
        '--run-label',
        'j=2',
      ],
      { verb: 'start', values: { workflow: 'b', label: ['l1', 'l2'], 'run-label': ['k=1', 'j=2'] } },
    ],
    [
      ['import', 'HEAD', '--from', 'a', '--meta', 'm1', '--from', 'b', '--meta', 'm2'],
      { verb: 'import', values: { from: 'b', meta: 'm2' } },
    ],
  ])('reads %j', async (argv, expected) => {
    expect(await quietly(argv)).toMatchObject(expected);
  });

  it.each([
    [['merge', '3', '--once']],
    [['start', 'x', '--step', 's']],
    [['loop', '--apply']],
    [['studio', '--label', 'x']],
    [['show', '--workflow', 'w']],
    [['status']],
    [['merge', '--nope']],
    [['say', '3', 'hi', '--run-label', 'arm=v2']],
    [['label', 'run-1', '--run-label', 'arm=v2']],
    [['label', 'run-1', '--from', 'x']],
    [['import', 'HEAD', '--label', 'x']],
    [['check', '--meta', 'm.json']],
    [['show', '--forge', 'f']],
  ])('refuses %j with exit 2', async argv => {
    expect(await quietly(argv)).toBe(2);
  });

  it.each([[[]], [['--help']], [['-h']], [['--version']], [['check', '--help']]])(
    'answers %j with exit 0',
    async argv => {
      expect(await quietly(argv)).toBe(0);
    }
  );
});

describe('the agi command', () => {
  const run = (...args: string[]) => {
    const repo = tmp('cli-repo');
    const data = join(tmp('cli-data'), 'root');
    const tracker = join(tmp('cli-tracker'), 'tracker');
    git(repo, 'init', '-q');
    const ran = spawnSync(process.execPath, [runTs, ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '', AGENTGRAPH_DATA: data, AGENTGRAPH_TRACKER: '', AGENTGRAPH_DIR: '' },
    });
    return { ...ran, data, tracker, repo };
  };

  it.each([
    [['merge', '3', '--once'], 'Unrecognized flag: --once'],
    [['start', 'Fix it', '--step', 'x'], 'Unrecognized flag: --step'],
    [['loop', '--apply'], 'Unrecognized flag: --apply'],
    [['prune-logs', '--label', 'x'], 'Unrecognized flag: --label'],
    [['say', '3', 'hi', '--run-label', 'arm=v2'], 'Unrecognized flag: --run-label'],
    [['import', 'HEAD', '--workflow', 'w'], 'Unrecognized flag: --workflow'],
  ])('refuses %j with exit 2 before it writes anything', (args, message) => {
    const ran = run(...args);
    const again = run(...args, '--tracker', ran.tracker);
    const seen = [ran, again].map(r => [
      r.status,
      r.stderr,
      existsSync(r.data),
      existsSync(r.tracker),
      readdirSync(r.repo),
    ]);
    const refused = [2, expect.stringContaining(message), false, false, ['.git']];
    expect(seen).toEqual([refused, refused]);
  });

  it.each([
    ['check', ['--runs', '--issue', '--workflow', '--data'], ['--once', '--label']],
    ['start', ['--workflow', '--label', '--run-label', '--dir'], ['--runs', '--apply', '--from']],
    ['merge', ['--data', '--tracker'], ['--once', '--workflow', '--run-label']],
    ['label', ['--data', '--tracker'], ['--run-label', '--workflow', '--meta']],
    ['import', ['--from', '--meta', '--data'], ['--run-label', '--workflow', '--once']],
  ])('prints the flags %s takes', (verb, shown, hidden) => {
    const ran = run(verb, '--help');
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain(`agi ${verb}`);
    expect([
      shown.filter(flag => !ran.stdout.includes(flag)),
      hidden.filter(flag => ran.stdout.includes(flag)),
    ]).toEqual([[], []]);
  });

  it.each([
    [[], 0, 'agi <subcommand>'],
    [['--version'], 0, ''],
    [['nope'], 2, 'Unknown subcommand'],
  ] as const)('exits %j with %i', (args, code, text) => {
    const ran = run(...args);
    expect([ran.status, ran.stdout + ran.stderr]).toEqual([code, expect.stringContaining(text)]);
  });
});
