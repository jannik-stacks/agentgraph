import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bothubServer } from '../src/mcp-config.ts';
import {
  bothubArg,
  bothubPaths,
  containerEnv,
  dockerRun,
  gitMounts,
  inside,
  mcpInside,
  SandboxError,
  sandboxConfig,
  specInside,
} from '../src/sandbox.ts';
import type { RunSpec } from '../src/types.ts';
import { temp } from './kit.ts';

const root = join(import.meta.dirname, '..');

describe('sandboxConfig', () => {
  it('accepts no settings', () => {
    expect(sandboxConfig({})).toMatchObject({ image: 'bothub-sandbox:local', memory: '4g', cpus: '1.5', pids: '512' });
  });

  it.each([
    ['BOTHUB_SANDBOX_IMAGE', '--privileged'],
    ['BOTHUB_SANDBOX_IMAGE', ''],
    ['BOTHUB_SANDBOX_MEMORY', '0'],
    ['BOTHUB_SANDBOX_MEMORY', '-1'],
    ['BOTHUB_SANDBOX_CPUS', '0'],
    ['BOTHUB_SANDBOX_PIDS', '-1'],
    ['BOTHUB_SANDBOX_PIDS', '0'],
  ])('rejects %s=%j', (key, value) => {
    expect(() => sandboxConfig({ [key]: value })).toThrow(SandboxError);
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
    config: sandboxConfig({}),
    user: '501:20',
  });

  it('keeps stdin open only when asked', () => {
    expect(run.args).not.toContain('-i');
    const piped = dockerRun({
      name: 'bothub-r1',
      worktree: '/data/work/r1',
      env: {},
      secrets: {},
      cmd: 'sh',
      args: [],
      config: sandboxConfig({}),
      user: '501:20',
      stdin: true,
    });
    expect(piped.args.slice(0, 4)).toContain('-i');
  });

  it('hardens the container and joins the internal network', () => {
    expect(run.cmd).toBe('docker');
    expect(run.args).toEqual(
      expect.arrayContaining(['--rm', '--read-only', '--cap-drop=ALL', 'no-new-privileges=true', '--init'])
    );
    expect(run.args[run.args.indexOf('--tmpfs') + 1]).toBe('/tmp:rw,exec,nosuid,nodev,size=1g');
    expect(run.args.slice(run.args.indexOf('--network'), run.args.indexOf('--network') + 2)).toEqual([
      '--network',
      'bothub-sandbox',
    ]);
    expect(run.args).toContain('501:20');
    expect(run.args.slice(run.args.indexOf('--pull'), run.args.indexOf('--pull') + 2)).toEqual(['--pull', 'never']);
  });

  const base = { name: 'n', worktree: '/w', env: {}, cmd: 'sh', args: [], config: sandboxConfig({}) };

  it.each(['0:0', '0:20', 'root', '', '501'])('refuses to run as user %j', user => {
    expect(() => dockerRun({ ...base, user })).toThrow(SandboxError);
  });

  it.each([
    { src: '/var/run/docker.sock', dst: '/var/run/docker.sock' },
    { src: '/Users/me/.docker/run/docker.sock', dst: '/s' },
    { src: '/var/run', dst: '/x' },
    { src: '/', dst: '/host' },
    { src: '/a', dst: '/' },
    { src: '/a,dst=/etc', dst: '/b' },
  ])('refuses the mount %o', mount => {
    expect(() => dockerRun({ ...base, user: '501:20', mounts: [mount] })).toThrow(SandboxError);
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

  it('adds the open network and the cache only when asked', () => {
    expect(run.args.filter(arg => arg === '--network')).toHaveLength(1);
    const open = dockerRun({ ...base, user: '501:20', open: true, cache: '/data/cache/h' });
    expect(open.args.join(' ')).toContain('--network bothub-sandbox --network bothub-open');
    expect(open.args).toContain('type=bind,src=/data/cache/h,dst=/cache');
    expect(open.args).toContain('BOTHUB_CACHE=/cache');
    expect(run.args.join(' ')).not.toContain('BOTHUB_CACHE');
  });

  it('mounts the worktree read-only when asked', () => {
    const ro = dockerRun({ ...base, user: '501:20', worktree: '/data/work/r1', readonly: true });
    expect(ro.args).toContain('type=bind,src=/data/work/r1,dst=/work,readonly');
  });

  it('passes secrets by name only and ends with the image and command', () => {
    expect(run.args.join(' ')).not.toContain('sk-secret');
    expect(run.args).toContain('BOTHUB_LLM_API_KEY');
    expect(run.args).toContain('HOME=/home/agent');
    expect(run.env).toEqual({ BOTHUB_LLM_API_KEY: 'sk-secret' });
    expect(run.args.slice(-5)).toEqual(['bothub-sandbox:local', 'opencode', 'run', '--', 'hi']);
  });
});

describe('containerEnv', () => {
  it('routes through the egress proxy unless the network is open', () => {
    expect(containerEnv({})).toMatchObject({ HTTPS_PROXY: 'http://egress:8888', NO_PROXY: expect.any(String) });
    const open = containerEnv({}, true);
    expect(Object.keys(open).filter(key => /proxy/i.test(key))).toEqual([]);
    expect(open.BOTHUB_DECIDE_URL).toBe(containerEnv({}).BOTHUB_DECIDE_URL);
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
    expect(await gitMounts(work, true)).toEqual([
      { src: join(dir, 'repos', 'a', 'b.git'), dst: join(dir, 'repos', 'a', 'b.git'), readonly: true },
      { src: admin, dst: admin, readonly: true },
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
    const spec: RunSpec = { prompt: 'p', system: 's', cwd: '/srv/work/r1', tools: [], mcp: server };
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

  it('gives the surfacer the same read-only hub and run store mounts, once', () => {
    const surfacer = { run: 'r1', bot: 'b', data: '/srv/data', hub: '/srv/hub', history: true };
    const spec: RunSpec = { prompt: 'p', system: 's', cwd: '/srv/work/r1', tools: [], surfacer };
    const alone = specInside(spec);
    expect(alone.spec.surfacer).toEqual({ ...surfacer, data: '/data', hub: '/hub' });
    expect(alone.mounts.slice(-2)).toEqual([
      { src: '/srv/hub', dst: '/hub', readonly: true },
      { src: '/srv/data/runs', dst: '/data/runs', readonly: true },
    ]);
    const both = specInside({ ...spec, mcp: server });
    expect(new Set(both.mounts.map(m => m.dst)).size).toBe(both.mounts.length);
    expect(both.mounts.filter(m => m.dst === '/hub' || m.dst === '/data/runs')).toHaveLength(2);
  });

  it('maps quoted paths into bothub code inside inline JSON', () => {
    const json = JSON.stringify({
      plugin: [[join(root, 'src', 'harnesses', 'opencode-surfacer.ts'), {}]],
      other: '/x',
    });
    expect(JSON.parse(bothubPaths(json))).toEqual({
      plugin: [[`${inside.bothub}/src/harnesses/opencode-surfacer.ts`, {}]],
      other: '/x',
    });
  });

  it('maps paths into bothub code and leaves others alone', () => {
    expect(bothubArg(join(root, 'src', 'harnesses', 'pi-provider.ts'))).toBe(
      `${inside.bothub}/src/harnesses/pi-provider.ts`
    );
    expect(bothubArg('/elsewhere/x.ts')).toBe('/elsewhere/x.ts');
  });
});
