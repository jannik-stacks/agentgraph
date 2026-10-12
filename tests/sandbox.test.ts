import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bothubServer } from '../src/mcp-config.ts';
import {
  bothubArg,
  dockerRun,
  gitMounts,
  inside,
  mcpInside,
  sandboxDefaults,
  sandboxFrom,
  specInside,
} from '../src/sandbox.ts';
import type { RunSpec } from '../src/types.ts';
import { temp } from './git.ts';

const root = join(import.meta.dirname, '..');

describe('sandboxFrom', () => {
  it('runs on the host unless BOTHUB_SANDBOX is docker', () => {
    expect(sandboxFrom({})).toBe('host');
    expect(sandboxFrom({ BOTHUB_SANDBOX: 'yes' })).toBe('host');
    expect(sandboxFrom({ BOTHUB_SANDBOX: 'docker' })).toBe('docker');
  });
});

describe('dockerRun', () => {
  const run = dockerRun({
    name: 'bothub-r1',
    worktree: '/data/work/r1',
    home: '/data/runs/r1/home',
    mounts: [{ src: '/hub', dst: '/hub', readonly: true }],
    env: { HOME: '/home/agent' },
    secrets: { BOTHUB_LLM_API_KEY: 'sk-secret' },
    cmd: 'opencode',
    args: ['run', '--', 'hi'],
    defaults: sandboxDefaults({}),
    user: '501:20',
  });

  it('hardens the container and joins the internal network', () => {
    expect(run.cmd).toBe('docker');
    expect(run.args).toEqual(
      expect.arrayContaining(['--rm', '--read-only', '--cap-drop=ALL', 'no-new-privileges=true', '--init'])
    );
    expect(run.args.slice(run.args.indexOf('--network'), run.args.indexOf('--network') + 2)).toEqual([
      '--network',
      'bothub-sandbox',
    ]);
    expect(run.args).toContain('501:20');
  });

  it('mounts the worktree as /work, the run home and extra mounts', () => {
    expect(run.args).toContain('type=bind,src=/data/work/r1,dst=/work');
    expect(run.args).toContain('type=bind,src=/data/runs/r1/home,dst=/home/agent');
    expect(run.args).toContain('type=bind,src=/hub,dst=/hub,readonly');
    expect(run.args.slice(run.args.indexOf('--workdir'), run.args.indexOf('--workdir') + 2)).toEqual([
      '--workdir',
      '/work',
    ]);
  });

  it('passes secrets by name only and ends with the image and command', () => {
    expect(run.args.join(' ')).not.toContain('sk-secret');
    expect(run.args).toContain('BOTHUB_LLM_API_KEY');
    expect(run.args).toContain('HOME=/home/agent');
    expect(run.env).toEqual({ BOTHUB_LLM_API_KEY: 'sk-secret' });
    expect(run.args.slice(-5)).toEqual(['bothub-sandbox:local', 'opencode', 'run', '--', 'hi']);
  });
});

describe('gitMounts', () => {
  it('mounts the mirror read-only and the worktree admin dir read-write', async () => {
    const dir = temp('sandbox');
    const admin = join(dir, 'repos', 'a', 'b.git', 'worktrees', 'r1');
    mkdirSync(admin, { recursive: true });
    writeFileSync(join(admin, 'commondir'), '../..\n');
    const work = join(dir, 'work', 'r1');
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, '.git'), `gitdir: ${admin}\n`);
    expect(await gitMounts(work)).toEqual([
      { src: join(dir, 'repos', 'a', 'b.git'), dst: join(dir, 'repos', 'a', 'b.git'), readonly: true },
      { src: admin, dst: admin },
    ]);
    expect(await gitMounts(dir)).toEqual([]);
  });
});

describe('mcpInside and specInside', () => {
  const server = bothubServer({ dir: '/srv/hub', tools: ['issues_get'], repo: 'a/b', data: '/srv/data' });

  it('runs the MCP server with the image node on read-only mounts of the hub and run store', () => {
    const { server: seen, mounts } = mcpInside(server);
    expect(seen.command).toBe('node');
    expect(seen.args).toEqual([
      `${inside.bothub}/bin/bothub.mjs`,
      'mcp',
      '--dir',
      '/hub',
      '--repo',
      'a/b',
      '--tools',
      'issues_get',
      '--data',
      '/data',
    ]);
    expect(mounts).toEqual([
      { src: '/srv/hub', dst: '/hub', readonly: true },
      { src: '/srv/data/runs', dst: '/data/runs', readonly: true },
    ]);
  });

  it('moves the spec to /work and mounts only the code parts of bothub', () => {
    const spec: RunSpec = { prompt: 'p', system: 's', cwd: '/srv/work/r1', tools: [], maxTurns: 1, mcp: server };
    const { spec: seen, mounts } = specInside(spec);
    expect(seen.cwd).toBe('/work');
    expect(seen.mcp?.command).toBe('node');
    expect(mounts.map(m => m.src)).toEqual([
      join(root, 'bin'),
      join(root, 'src'),
      join(root, 'node_modules'),
      join(root, 'package.json'),
      '/srv/hub',
      '/srv/data/runs',
    ]);
    expect(mounts.every(m => m.readonly)).toBe(true);
  });

  it('maps paths into bothub code and leaves others alone', () => {
    expect(bothubArg(join(root, 'src', 'executors', 'pi-provider.ts'))).toBe(
      `${inside.bothub}/src/executors/pi-provider.ts`
    );
    expect(bothubArg('/elsewhere/x.ts')).toBe('/elsewhere/x.ts');
  });
});
