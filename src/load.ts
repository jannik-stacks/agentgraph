import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hubFile, type SourceFile } from './config.ts';

const markdown = async (dir: string, sub: string): Promise<SourceFile[]> => {
  const names = await readdir(join(dir, sub)).catch(() => []);
  return Promise.all(
    names
      .filter(name => name.endsWith('.md'))
      .sort()
      .map(async name => ({ path: `${sub}/${name}`, source: await readFile(join(dir, sub, name), 'utf8') }))
  );
};

/** Reads a hub directory's `hub.yaml`, definition files and `notes/<kind>/*.md`. Missing ones count as empty. */
export const readHub = async (dir: string): Promise<SourceFile[]> => {
  const hub = await readFile(join(dir, hubFile), 'utf8').then(
    source => [{ path: hubFile, source }],
    () => []
  );
  const kinds = await readdir(join(dir, 'notes'), { withFileTypes: true }).catch(() => []);
  const subs = [
    'bots',
    'skills',
    'checks',
    'workflows',
    ...kinds
      .filter(entry => entry.isDirectory())
      .map(entry => `notes/${entry.name}`)
      .sort(),
  ];
  return [...hub, ...(await Promise.all(subs.map(sub => markdown(dir, sub)))).flat()];
};
