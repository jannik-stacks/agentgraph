import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { api } from '../src/api.ts';
import { fingerprint, srcDir } from '../src/fingerprint.ts';
import { openStore } from '../src/store.ts';
import { studioModule } from './studio.ts';

const tree = () => {
  const dir = mkdtempSync(join(tmpdir(), 'bothub-fingerprint-'));
  mkdirSync(join(dir, 'harnesses'));
  writeFileSync(join(dir, 'api.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'harnesses', 'pi.ts'), 'export const b = 2;\n');
  return dir;
};

const handler = (dir: string) =>
  api({ hubDir: tree(), store: openStore(mkdtempSync(join(tmpdir(), 'bothub-fp-data-'))), srcDir: dir });
const build = async (h: ReturnType<typeof api>) =>
  (await (await h(new Request('http://127.0.0.1/api/build'))).json()) as {
    running: string;
    disk: string;
    stale: boolean;
  };

describe('fingerprint', () => {
  it('is stable while nothing changes', () => {
    const dir = tree();
    expect(fingerprint(dir)).toBe(fingerprint(dir));
  });

  it('changes when a file is edited, added, removed or renamed', () => {
    const dir = tree();
    const seen = new Set([fingerprint(dir)]);
    writeFileSync(join(dir, 'harnesses', 'pi.ts'), 'export const b = 3;\n');
    seen.add(fingerprint(dir));
    writeFileSync(join(dir, 'new.ts'), '');
    seen.add(fingerprint(dir));
    rmSync(join(dir, 'new.ts'));
    rmSync(join(dir, 'api.ts'));
    seen.add(fingerprint(dir));
    writeFileSync(join(dir, 'renamed.ts'), 'export const a = 1;\n');
    seen.add(fingerprint(dir));
    expect(seen.size).toBe(5);
  });

  it('defaults to the bothub source directory', () => {
    expect(srcDir).toBe(join(import.meta.dirname, '..', 'src'));
    expect(fingerprint()).toBe(fingerprint(srcDir));
  });
});

describe('GET /api/build', () => {
  it('reports stale once the source changes after the handler was made', async () => {
    const dir = tree();
    const h = handler(dir);
    const before = await build(h);
    expect(before).toEqual({ running: before.disk, disk: fingerprint(dir), stale: false });
    writeFileSync(join(dir, 'api.ts'), 'export const a = 2;\n');
    expect(await build(h)).toEqual({ running: before.running, disk: fingerprint(dir), stale: true });
    expect((await build(handler(dir))).stale).toBe(false);
  });

  it('drives the studio banner, which also treats an API without the route as out of date', async () => {
    const { isStale } = await studioModule<{ isStale: (get: typeof fetch) => Promise<boolean> }>('StaleApi.tsx');
    const dir = tree();
    const h = handler(dir);
    const get = ((path: string) => h(new Request(`http://127.0.0.1${path}`))) as typeof fetch;
    expect(await isStale(get)).toBe(false);
    writeFileSync(join(dir, 'api.ts'), 'export const a = 2;\n');
    expect(await isStale(get)).toBe(true);
    const old = (async () => Response.json({ error: 'not found' }, { status: 404 })) as typeof fetch;
    expect(await isStale(old)).toBe(true);
  });
});
