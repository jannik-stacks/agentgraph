import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** The source directory this module was loaded from. */
export const srcDir = import.meta.dirname;

/** A hash of every file's path and contents under `dir`, so any edit, addition or removal changes it. */
export const fingerprint = (dir: string = srcDir) => {
  const hash = createHash('sha256');
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name))
    .sort();
  for (const file of files) hash.update(`${relative(dir, file).split(sep).join('/')}\0`).update(readFileSync(file));
  return hash.digest('hex').slice(0, 16);
};
