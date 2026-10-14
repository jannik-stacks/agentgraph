import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cacheEnv, hubBox, hubCache, hubImage } from '../src/hub-sandbox.ts';
import { SandboxError } from '../src/sandbox.ts';
import { temp } from './kit.ts';

describe('hubBox', () => {
  it('keeps the base image without a setup script, and one cache per hub', async () => {
    const data = temp('hub-sandbox');
    const sandbox = { env: { CARGO_TARGET_DIR: '/work/target' }, network: 'open' as const, memory: '10g', cpus: 8 };
    const box = await hubBox(sandbox, '/hubs/a', data)();
    expect(box).toEqual({
      config: { memory: '10g', cpus: '8' },
      env: { ...cacheEnv(), CARGO_TARGET_DIR: '/work/target' },
      open: true,
      cache: await hubCache(data, '/hubs/a'),
    });
    expect(existsSync(box.cache!)).toBe(true);
    expect(await hubCache(data, '/hubs/b')).not.toBe(box.cache);
    expect(await hubBox({ env: {}, network: 'allowlist' }, '/hubs/a')()).toEqual({ config: {}, env: {}, open: false });
  });

  const sandbox = { env: {}, network: 'allowlist' as const };
  const envOf = async (event: { repo: string; number?: number }, data = temp('hub-sandbox')) =>
    (await hubBox(sandbox, '/hubs/a', data, event)()).env!;

  it('gives runs on different issues different build directories', async () => {
    const dirs = await Promise.all(
      [
        { repo: 'acme/app', number: 1 },
        { repo: 'acme/app', number: 2 },
        { repo: 'acme/lib', number: 1 },
        { repo: 'acme/app' },
      ].map(async event => (await envOf(event)).CARGO_TARGET_DIR)
    );
    expect(new Set(dirs).size).toBe(4);
  });

  it('keeps one build directory for every run on the same issue', async () => {
    const data = temp('hub-sandbox');
    const box = hubBox(sandbox, '/hubs/a', data, { repo: 'acme/app', number: 7 });
    const first = (await box()).env!.CARGO_TARGET_DIR;
    expect(first).toMatch(/^\/cache\/target\/[0-9a-f]{16}$/);
    expect((await box()).env!.CARGO_TARGET_DIR).toBe(first);
    const later = { id: 'later', repo: 'acme/app', number: 7, body: '/bothub' };
    expect((await envOf(later, data)).CARGO_TARGET_DIR).toBe(first);
  });

  it('shares the package caches across issues', async () => {
    const { CARGO_TARGET_DIR: _, ...one } = await envOf({ repo: 'acme/app', number: 1 });
    const { CARGO_TARGET_DIR: __, ...two } = await envOf({ repo: 'acme/lib', number: 2 });
    expect(one).toEqual(two);
    expect(one).toMatchObject({ CARGO_HOME: '/cache/cargo', npm_config_cache: '/cache/npm' });
  });

  it('fails as a sandbox error on a setup script it cannot find', async () => {
    const hub = temp('hub-sandbox');
    await expect(hubImage('bothub-sandbox:local', hub, join('sandbox', 'setup.sh'))).rejects.toThrow(SandboxError);
  });
});
