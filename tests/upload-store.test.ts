import type * as FileSystem from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';
import { fileStore, Store } from '../src/store.ts';
import { tmp } from './kit.ts';

const fs = createRequire(import.meta.url)('node:fs/promises') as typeof FileSystem;

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('removes the temporary upload when interrupted after fsync and before rename', async () => {
  const dir = tmp('interrupted-upload');
  directories.push(dir);
  const controller = new AbortController();
  const open = fs.open;
  let synced = false;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const file = await open(...args);
    const sync = file.sync.bind(file);
    vi.spyOn(file, 'sync').mockImplementation(async () => {
      await sync();
      synced = true;
      controller.abort(new Error('interrupted publication'));
    });
    return file;
  });
  syncBuiltinESMExports();
  await expect(
    Effect.runPromise(
      Effect.flatMap(Store, store => store.putFile(new Uint8Array([1, 2, 3]), controller.signal)).pipe(
        Effect.provide(fileStore(dir)),
        Effect.mapError(error => error.cause)
      )
    )
  ).rejects.toThrow('interrupted publication');
  expect(synced).toBe(true);
  expect(await fs.readdir(join(dir, 'files'))).toEqual([]);
});

it('leaves no final upload when rename fails', async () => {
  const dir = tmp('failed-upload');
  directories.push(dir);
  vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('publication failed'));
  syncBuiltinESMExports();
  await expect(
    Effect.runPromise(
      Effect.flatMap(Store, store => store.putFile(new Uint8Array([1, 2, 3]), new AbortController().signal)).pipe(
        Effect.provide(fileStore(dir)),
        Effect.mapError(error => error.cause)
      )
    )
  ).rejects.toThrow('publication failed');
  expect(await fs.readdir(join(dir, 'files'))).toEqual([]);
});
